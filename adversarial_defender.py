import os
import argparse
from math import exp
# pyrefly: ignore [missing-import]
import torch
# pyrefly: ignore [missing-import]
import torch.nn as nn
# pyrefly: ignore [missing-import]
import torch.nn.functional as F
# pyrefly: ignore [missing-import]
from torch.autograd import Variable
# pyrefly: ignore [missing-import]
from PIL import Image
# pyrefly: ignore [missing-import]
import numpy as np

# ==========================================
# 1. PyTorch 기반 미분 가능한 SSIM 모듈 구현
# ==========================================

def gaussian(window_size, sigma):
    gauss = torch.Tensor([exp(-(x - window_size // 2) ** 2 / float(2 * sigma ** 2)) for x in range(window_size)])
    return gauss / gauss.sum()

def create_window(window_size, channel):
    _1D_window = gaussian(window_size, 1.5).unsqueeze(1)
    _2D_window = _1D_window.mm(_1D_window.t()).float().unsqueeze(0).unsqueeze(0)
    window = Variable(_2D_window.expand(channel, 1, window_size, window_size).contiguous())
    return window

def _ssim(img1, img2, window, window_size, channel, size_average=True):
    mu1 = F.conv2d(img1, window, padding=window_size // 2, groups=channel)
    mu2 = F.conv2d(img2, window, padding=window_size // 2, groups=channel)

    mu1_sq = mu1.pow(2)
    mu2_sq = mu2.pow(2)
    mu1_mu2 = mu1 * mu2

    sigma1_sq = F.conv2d(img1 * img1, window, padding=window_size // 2, groups=channel) - mu1_sq
    sigma2_sq = F.conv2d(img2 * img2, window, padding=window_size // 2, groups=channel) - mu2_sq
    sigma12 = F.conv2d(img1 * img2, window, padding=window_size // 2, groups=channel) - mu1_mu2

    C1 = 0.01 ** 2
    C2 = 0.03 ** 2

    ssim_map = ((2 * mu1_mu2 + C1) * (2 * sigma12 + C2)) / ((mu1_sq + mu2_sq + C1) * (sigma1_sq + sigma2_sq + C2))

    if size_average:
        return ssim_map.mean()
    else:
        return ssim_map.mean(1).mean(1).mean(1)

class SSIM(nn.Module):
    def __init__(self, window_size=11, size_average=True):
        super(SSIM, self).__init__()
        self.window_size = window_size
        self.size_average = size_average
        self.channel = 1
        self.window = create_window(window_size, self.channel)

    def forward(self, img1, img2):
        (_, channel, _, _) = img1.size()

        if channel == self.channel and self.window.data.type() == img1.data.type():
            window = self.window
        else:
            window = create_window(self.window_size, channel)
            
            if img1.is_cuda:
                window = window.cuda(img1.get_device())
            window = window.type_as(img1)
            
            self.window = window
            self.channel = channel

        return _ssim(img1, img2, window, self.window_size, channel, self.size_average)


# ==========================================
# 2. 임베딩 추출기 백본 모델 Fallback 정의
# ==========================================

class MockFaceModel(nn.Module):
    """
    얼굴 인식 라이브러리(facenet-pytorch 등)가 없는 환경에서
    테스트를 진행하기 위한 가상의 합성곱 기반 특징점 추출기 모델.
    """
    def __init__(self):
        super(MockFaceModel, self).__init__()
        self.features = nn.Sequential(
            nn.Conv2d(3, 16, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2, 2),
            nn.Conv2d(16, 32, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d((8, 8))
        )
        self.fc = nn.Linear(32 * 8 * 8, 128)

    def forward(self, x):
        x = self.features(x)
        x = x.view(x.size(0), -1)
        x = self.fc(x)
        # L2 정규화하여 128차원의 임베딩 생성
        return F.normalize(x, p=2, dim=1)


# ==========================================
# 3. Adversarial Defender 핵심 클래스
# ==========================================

class AdversarialDefender:
    def __init__(self, model=None, device=None):
        self.device = device if device is not None else torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
        # 모델 로드 (제시되지 않았을 경우 Mock Model 사용)
        if model is None:
            print("[Info] 랜드마크/임베딩 교란 테스트를 위한 MockFaceModel을 셋업합니다.")
            self.model = MockFaceModel().to(self.device)
        else:
            self.model = model.to(self.device)
            
        self.model.eval()
        self.ssim_module = SSIM().to(self.device)

    def generate_landmark_mask(self, image_shape, landmarks, radius=20):
        """
        눈, 코, 입 등 핵심 랜드마크 부위에만 공격 노이즈를 주입하기 위해
        랜드마크 좌표 주변에 Gaussian Soft Mask를 생성합니다.
        
        Args:
            image_shape (tuple): (H, W) 이미지의 높이와 너비
            landmarks (list of tuples/lists): [(x1, y1), (x2, y2), ...] 형태의 특징점 좌표 목록
            radius (float): 랜드마크 교란 영향력 반경 (기본값: 20px)
        Returns:
            torch.Tensor: (1, 1, H, W) 차원의 미분 가능한 마스크 텐서
        """
        H, W = image_shape[-2], image_shape[-1]
        mask = torch.zeros((H, W), dtype=torch.float32)
        
        # Grid Coordinates
        y_grid, x_grid = torch.meshgrid(
            torch.arange(H, dtype=torch.float32), 
            torch.arange(W, dtype=torch.float32), 
            indexing='ij'
        )
        
        for landmark in landmarks:
            lx, ly = landmark[0], landmark[1]
            dist_sq = (x_grid - lx) ** 2 + (y_grid - ly) ** 2
            # Radial basis function 형태로 랜드마크 주변부에 가우시안 소프트 가중치 부여
            landmark_influence = torch.exp(-dist_sq / (2.0 * (radius ** 2)))
            mask = torch.max(mask, landmark_influence)
            
        # 노이즈가 주변부에 너무 강하게 번지는 것을 부드럽게 조정
        mask = torch.clamp(mask, 0.0, 1.0)
        return mask.unsqueeze(0).unsqueeze(0).to(self.device) # (1, 1, H, W)

    def protect(self, image_tensor, landmarks=None, epsilon=16/255, alpha=2/255, steps=15, ssim_threshold=0.95, lambda_ssim=0.5):
        """
        SSIM 최소 0.95 제약 조건을 만족하면서 PGD 기법으로 랜드마크/임베딩 특징점을 교란합니다.
        
        Args:
            image_tensor (torch.Tensor): (1, C, H, W) 차원의 원본 이미지 텐서 (값 범위 0.0 ~ 1.0)
            landmarks (list): 랜드마크 좌표 목록
            epsilon (float): L_infinity norm 기반 최대 Perturbation 허용값
            alpha (float): PGD Iteration step 크기
            steps (int): PGD 반복 횟수
            ssim_threshold (float): 최종 이미지의 화질 보존을 위한 최소 SSIM 값 (기본값: 0.95)
            lambda_ssim (float): Loss Function 내의 SSIM 페널티 항 가중치
        Returns:
            torch.Tensor: 보호 처리된 적대적 이미지 텐서 (1, C, H, W)
        """
        # 입력 데이터 준비
        X = image_tensor.clone().detach().to(self.device)
        X.requires_grad = False
        
        # 적대적 노이즈를 가할 이미지 초기화
        X_adv = X.clone().detach().requires_grad_(True)
        
        # 1. 특징점(Latent/Embedding) 교란 대상: 원본 임베딩 벡터 추출
        with torch.no_grad():
            target_embedding = self.model(X)
            
        # 2. 랜드마크 마스크 생성 (전달받았을 경우에만 적용)
        mask = None
        if landmarks is not None and len(landmarks) > 0:
            mask = self.generate_landmark_mask(X.shape, landmarks)
            print(f"[Info] 랜드마크 마스킹이 활성화되었습니다. (총 {len(landmarks)}개 포인트 교란 집중)")
            
        print(f"[Run] PGD 공격을 시작합니다. (Steps: {steps}, Epsilon: {epsilon:.4f}, 최소 SSIM 제약: {ssim_threshold})")
        
        for step in range(steps):
            # 순전파로 적대적 이미지의 임베딩 추출
            embedding_adv = self.model(X_adv)
            
            # Loss Function 설계
            #  - CosineSimilarity를 '최소화' (두 특징 벡터를 최대한 다른 방향으로 유도)
            #  - SSIM Loss를 '최소화'하여 화질이 지나치게 손상되지 않도록 최적화 지원
            loss_sim = F.cosine_similarity(target_embedding, embedding_adv).mean()
            loss_ssim = 1.0 - self.ssim_module(X, X_adv)
            
            total_loss = loss_sim + lambda_ssim * loss_ssim
            
            # Gradient 역전파
            if X_adv.grad is not None:
                X_adv.grad.zero_()
            total_loss.backward()
            
            with torch.no_grad():
                # Gradient Descent 적용을 위한 부호(Sign) 계산
                # (Cosine Similarity를 줄여야 하므로 gradient의 '반대' 방향으로 업데이트)
                grad_sign = X_adv.grad.sign()
                
                # [조건 3] 특징점/랜드마크 집중 교란을 위한 Masking 적용
                if mask is not None:
                    grad_sign = grad_sign * mask
                    
                # [조건 1] PGD Step 업데이트
                X_adv = X_adv - alpha * grad_sign
                
                # L_infinity Bound 투영
                delta = X_adv - X
                delta = torch.clamp(delta, -epsilon, epsilon)
                X_adv = torch.clamp(X + delta, 0.0, 1.0)
                
                # [조건 2] SSIM 화질 보존 제약 (SSIM >= 0.95) 강제화
                current_ssim = self.ssim_module(X, X_adv).item()
                if current_ssim < ssim_threshold:
                    # 이분 탐색(Binary Search)을 통한 Perturbation 크기 정교한 수축
                    low, high = 0.0, 1.0
                    best_gamma = 0.0
                    delta_temp = X_adv - X
                    
                    for _ in range(8): # 8회 반복으로 고정밀 축소율 탐색
                        mid = (low + high) / 2.0
                        candidate_adv = torch.clamp(X + mid * delta_temp, 0.0, 1.0)
                        candidate_ssim = self.ssim_module(X, candidate_adv).item()
                        
                        if candidate_ssim >= ssim_threshold:
                            best_gamma = mid
                            low = mid # 노이즈가 더 들어갈 수 있는 공간 탐색
                        else:
                            high = mid # 화질 손상이 심하므로 강도를 줄임
                            
                    X_adv = torch.clamp(X + best_gamma * delta_temp, 0.0, 1.0)
                    
            # 다음 step을 위해 gradient 활성화
            X_adv.requires_grad_(True)
            
            # 진행 상태 로깅
            if (step + 1) % 3 == 0 or (step + 1) == steps:
                with torch.no_grad():
                    curr_sim = F.cosine_similarity(target_embedding, self.model(X_adv)).mean().item()
                    curr_ssim = self.ssim_module(X, X_adv).item()
                    print(f" -> Step {step+1:02d}/{steps:02d} | Embedding Cosine Sim: {curr_sim:.4f} | SSIM: {curr_ssim:.5f}")
                    
        return X_adv.detach()


# ==========================================
# 4. 이미지 헬퍼 유틸리티 함수
# ==========================================

def load_image_to_tensor(img_path):
    img = Image.open(img_path).convert('RGB')
    # numpy array 변환 및 정규화 [0, 1]
    img_arr = np.array(img).astype(np.float32) / 255.0
    # (H, W, C) -> (1, C, H, W)
    img_tensor = torch.from_numpy(img_arr).permute(2, 0, 1).unsqueeze(0)
    return img_tensor

def save_tensor_as_image(tensor, out_path):
    # (1, C, H, W) -> (C, H, W) -> (H, W, C)
    img_arr = tensor.squeeze(0).permute(1, 2, 0).cpu().numpy()
    img_arr = np.clip(img_arr * 255.0, 0, 255).astype(np.uint8)
    img = Image.fromarray(img_arr)
    img.save(out_path)
    print(f"[Save] 보호된 이미지를 저장했습니다: {out_path}")


# ==========================================
# 5. 가상 시나리오 테스트 및 실행 엔트리포인트
# ==========================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Deepfake 방어를 위한 SSIM 보존 PGD 적대적 노이즈 생성기")
    parser.add_argument("--image", type=str, default=None, help="보호할 원본 이미지 파일 경로 (생략 시 테스트 텐서 생성)")
    parser.add_argument("--output", type=str, default="protected_output.png", help="보호된 이미지 저장 경로")
    parser.add_argument("--epsilon", type=float, default=16/255, help="노이즈 최대 강도 (L_infinity bound)")
    parser.add_argument("--steps", type=int, default=15, help="PGD 최적화 반복 횟수")
    parser.add_argument("--ssim", type=float, default=0.95, help="최소 보존할 SSIM 임계치")
    
    args = parser.parse_args()
    
    # 디바이스 설정
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[Device] 연산 디바이스: {device}")
    
    # 1. 랜드마크 디펜더 초기화
    defender = AdversarialDefender(device=device)
    
    # 2. 이미지 데이터 준비
    if args.image and os.path.exists(args.image):
        print(f"[Load] 이미지를 불러오는 중: {args.image}")
        orig_tensor = load_image_to_tensor(args.image).to(device)
        
        # 가상의 얼굴 랜드마크 좌표 설정 (얼굴 중앙 부근에 임의 설정)
        _, _, H, W = orig_tensor.shape
        landmarks = [
            [W * 0.35, H * 0.4],  # 왼눈
            [W * 0.65, H * 0.4],  # 오른눈
            [W * 0.5, H * 0.55],  # 코
            [W * 0.45, H * 0.7],  # 입 왼쪽
            [W * 0.55, H * 0.7]   # 입 오른쪽
        ]
    else:
        print("[Demo] 입력 이미지가 제공되지 않았거나 경로가 유효하지 않습니다. 모의 데이터로 테스트를 진행합니다.")
        # 가상의 3채널 256x256 이미지 텐서 생성
        orig_tensor = torch.rand((1, 3, 256, 256), dtype=torch.float32).to(device)
        landmarks = [
            [90, 100],  # 왼눈
            [166, 100], # 오른눈
            [128, 140], # 코
            [110, 180], # 입 왼쪽
            [146, 180]  # 입 오른쪽
        ]
        
    # 3. 방어적 공격 실행
    protected_tensor = defender.protect(
        image_tensor=orig_tensor,
        landmarks=landmarks,
        epsilon=args.epsilon,
        steps=args.steps,
        ssim_threshold=args.ssim
    )
    
    # 4. 결과 검증 출력
    with torch.no_grad():
        final_ssim = defender.ssim_module(orig_tensor, protected_tensor).item()
        orig_embed = defender.model(orig_tensor)
        prot_embed = defender.model(protected_tensor)
        final_sim = F.cosine_similarity(orig_embed, prot_embed).mean().item()
        
    print("\n" + "=" * 50)
    print("                 Final Protection Performance Report")
    print("=" * 50)
    print(f"  [+] SSIM Quality Metric   : {final_ssim:.5f} (Target >= {args.ssim:.2f})")
    print(f"  [+] Cosine Sim (Embedding): {final_sim:.5f} (Lower is better)")
    print(f"  [+] Defense Status        : {'SUCCESS (Visual preserved, embedding disrupted)' if final_ssim >= args.ssim and final_sim < 1.0 else 'Needs Adjustment'}")
    print("=" * 50)
    
    # 5. 결과 저장 (입력 이미지가 있었을 경우)
    if args.image and os.path.exists(args.image):
        save_tensor_as_image(protected_tensor, args.output)

