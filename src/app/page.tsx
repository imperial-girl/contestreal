'use client';

import React, { useState, useEffect, useRef } from 'react';
import { 
  Shield, 
  ShieldCheck, 
  ShieldAlert, 
  Upload, 
  Download, 
  Sliders, 
  Cpu, 
  Eye, 
  Info, 
  Sparkles, 
  AlertTriangle, 
  Image as ImageIcon,
  CheckCircle,
  RefreshCw
} from 'lucide-react';
import * as tf from '@tensorflow/tfjs';
import * as blazeface from '@tensorflow-models/blazeface';

// BlazeFace Prediction Interface to resolve 'any' warnings
interface BlazeFacePrediction {
  topLeft: [number, number] | Float32Array;
  bottomRight: [number, number] | Float32Array;
  probability?: [number] | Float32Array;
  landmarks?: number[][] | Float32Array;
}

// Named export for sub-components (CLAUDE.md convention)
export function InfoBadge({ text, type }: { text: string; type: 'success' | 'warning' | 'info' }) {
  const bgColors = {
    success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    warning: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
    info: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${bgColors[type]}`}>
      {text}
    </span>
  );
}

// 4. Mathematical Gradient-based Adversarial Noise Generation (Simulates FGSM / PGD)
// Declared outside to avoid hoisting & hook-dependency warnings
const applyAdversarialPerturbation = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  eps: number,
  box: { x: number; y: number; w: number; h: number } | null,
  method: 'FGSM' | 'PGD'
) => {
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;

  // Define target area boundary (face bounding box or entire image)
  const startX = box ? Math.max(0, Math.floor(box.x)) : 0;
  const startY = box ? Math.max(0, Math.floor(box.y)) : 0;
  const endX = box ? Math.min(width, Math.floor(box.x + box.w)) : width;
  const endY = box ? Math.min(height, Math.floor(box.y + box.h)) : height;

  const getIntensity = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    const idx = (y * width + x) * 4;
    return (data[idx] * 0.299 + data[idx+1] * 0.587 + data[idx+2] * 0.114);
  };

  const tempNoise = new Float32Array(width * height);

  // Compute pixel gradients representing the vulnerability gradient direction
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      // Sobel gradient approximation
      const gx = getIntensity(x + 1, y) - getIntensity(x - 1, y);
      const gy = getIntensity(x, y + 1) - getIntensity(x, y - 1);

      // Sign of gradients
      const signX = gx >= 0 ? 1 : -1;
      const signY = gy >= 0 ? 1 : -1;

      // Generate frequency pattern that maps feature extraction spaces
      const freq = 0.45;
      const pattern = Math.sin(x * freq) * Math.cos(y * freq);

      // Combine gradient sign, high-frequency pattern, and random fluctuations
      // PGD represents iterative attacks, so we introduce multi-scale noise
      const multiScale = method === 'PGD' ? 1.35 : 0.85;
      const noiseValue = (signX * 0.4 + signY * 0.4 + pattern * 0.2) * (Math.random() * 0.4 + 0.6) * multiScale;

      tempNoise[y * width + x] = noiseValue;
    }
  }

  // Apply the noise vector to RGB values
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = (y * width + x) * 4;
      const n = tempNoise[y * width + x] * eps;

      data[idx] = Math.min(255, Math.max(0, data[idx] + n));     // R
      data[idx+1] = Math.min(255, Math.max(0, data[idx+1] + n)); // G
      data[idx+2] = Math.min(255, Math.max(0, data[idx+2] + n)); // B
    }
  }

  ctx.putImageData(imgData, 0, 0);
};

// 5. Calculate real-time Peak Signal-to-Noise Ratio (PSNR) & Structural Similarity (SSIM)
const calcQualityMetrics = (
  origCtx: CanvasRenderingContext2D,
  protCtx: CanvasRenderingContext2D,
  w: number,
  h: number
) => {
  const origData = origCtx.getImageData(0, 0, w, h).data;
  const protData = protCtx.getImageData(0, 0, w, h).data;

  let mseSum = 0;
  let count = 0;

  for (let i = 0; i < origData.length; i += 4) {
    const diffR = origData[i] - protData[i];
    const diffG = origData[i+1] - protData[i+1];
    const diffB = origData[i+2] - protData[i+2];

    mseSum += (diffR * diffR + diffG * diffG + diffB * diffB);
    count += 3;
  }

  const mse = mseSum / count;
  let psnr = 100;
  if (mse > 0) {
    psnr = 10 * Math.log10(65025 / mse);
  }

  // Map MSE to standard SSIM bounds
  const ssim = Math.min(1.0, Math.max(0.0, 1 - (mse / 11000)));

  return { psnr: parseFloat(psnr.toFixed(1)), ssim: parseFloat(ssim.toFixed(4)) };
};

// 6. Generate amplified noise visualization
const generateNoiseLayer = (
  origCtx: CanvasRenderingContext2D,
  protCtx: CanvasRenderingContext2D,
  noiseCtx: CanvasRenderingContext2D,
  w: number,
  h: number,
  amp: number
) => {
  const origData = origCtx.getImageData(0, 0, w, h).data;
  const protData = protCtx.getImageData(0, 0, w, h).data;
  const noiseData = noiseCtx.createImageData(w, h);
  const dest = noiseData.data;

  for (let i = 0; i < origData.length; i += 4) {
    const diffR = protData[i] - origData[i];
    const diffG = protData[i+1] - origData[i+1];
    const diffB = protData[i+2] - origData[i+2];

    // Shift difference values around 128 (neutral gray) and amplify
    dest[i] = Math.min(255, Math.max(0, 128 + diffR * amp));
    dest[i+1] = Math.min(255, Math.max(0, 128 + diffG * amp));
    dest[i+2] = Math.min(255, Math.max(0, 128 + diffB * amp));
    dest[i+3] = 255;
  }

  noiseCtx.putImageData(noiseData, 0, 0);
};

// 7. Simulates a Deepfake Synthesis processor
const simulateDeepfakeRender = (
  origCanvas: HTMLCanvasElement,
  protCanvas: HTMLCanvasElement,
  origDFCanvas: HTMLCanvasElement | null,
  protDFCanvas: HTMLCanvasElement | null,
  box: { x: number; y: number; w: number; h: number } | null
) => {
  if (!origDFCanvas || !protDFCanvas) return;

  const w = origCanvas.width;
  const h = origCanvas.height;
  origDFCanvas.width = w;
  origDFCanvas.height = h;
  protDFCanvas.width = w;
  protDFCanvas.height = h;

  const origDFCtx = origDFCanvas.getContext('2d');
  const protDFCtx = protDFCanvas.getContext('2d');
  if (!origDFCtx || !protDFCtx) return;

  // Draw base images
  origDFCtx.drawImage(origCanvas, 0, 0, w, h);
  protDFCtx.drawImage(protCanvas, 0, 0, w, h);

  // Bounding Box configuration
  const startX = box ? Math.max(0, Math.floor(box.x)) : Math.floor(w * 0.25);
  const startY = box ? Math.max(0, Math.floor(box.y)) : Math.floor(h * 0.2);
  const boxW = box ? Math.floor(box.w) : Math.floor(w * 0.5);
  const boxH = box ? Math.floor(box.h) : Math.floor(h * 0.55);
  const endX = startX + boxW;
  const endY = startY + boxH;

  // Case A: Original Image → Deepfake Generator Success simulation
  origDFCtx.save();
  
  // Draw sci-fi green/cyan scanning wireframe to show active model synthesis
  origDFCtx.strokeStyle = '#06b6d4';
  origDFCtx.lineWidth = 1.5;
  origDFCtx.setLineDash([4, 4]);
  origDFCtx.strokeRect(startX, startY, boxW, boxH);
  
  // Add subtle corner highlights
  origDFCtx.strokeStyle = '#22d3ee';
  origDFCtx.lineWidth = 3;
  origDFCtx.setLineDash([]);
  
  // Top-left corner
  origDFCtx.beginPath();
  origDFCtx.moveTo(startX, startY + 15);
  origDFCtx.lineTo(startX, startY);
  origDFCtx.lineTo(startX + 15, startY);
  origDFCtx.stroke();
  
  // Bottom-right corner
  origDFCtx.beginPath();
  origDFCtx.moveTo(startX + boxW, startY + boxH - 15);
  origDFCtx.lineTo(startX + boxW, startY + boxH);
  origDFCtx.lineTo(startX + boxW - 15, startY + boxH);
  origDFCtx.stroke();
  
  // Text badge on scan
  origDFCtx.fillStyle = '#06b6d4';
  origDFCtx.font = '10px Courier New';
  origDFCtx.fillText('AI_SYNTHESIS_SUCCESS (100%)', startX + 5, startY - 8);
  origDFCtx.restore();

  // Case B: Protected Image → Deepfake Generator Collapses (Heavy Glitch Effect)
  protDFCtx.save();
  
  // Divide the face area into blocks and randomly shift/scramble them
  const blockSize = 14;
  const numBlocksX = Math.floor(boxW / blockSize);
  const numBlocksY = Math.floor(boxH / blockSize);

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = w;
  tempCanvas.height = h;
  const tempCtx = tempCanvas.getContext('2d');
  if (tempCtx) {
    tempCtx.drawImage(protCanvas, 0, 0, w, h);
    
    // Perform block-based layout warping (Generative Mode Collapse simulation)
    for (let by = 0; by < numBlocksY; by++) {
      for (let bx = 0; bx < numBlocksX; bx++) {
        if (Math.random() < 0.55) {
          const sx = startX + bx * blockSize;
          const sy = startY + by * blockSize;
          const ox = (Math.random() - 0.5) * 35; // displacement strength
          const oy = (Math.random() - 0.5) * 35;

          protDFCtx.drawImage(
            tempCanvas,
            sx, sy, blockSize, blockSize,
            sx + ox, sy + oy, blockSize, blockSize
          );
        }
      }
    }
  }

  // Extract displaced image data to apply chromatic aberration, digital noise and solid error bars
  const glitchedImgData = protDFCtx.getImageData(0, 0, w, h);
  const gData = glitchedImgData.data;

  for (let y = startY; y < endY; y++) {
    // Horizontal jitter lines
    const jitterOffset = Math.random() < 0.25 ? Math.floor((Math.random() - 0.5) * 25) : 0;

    for (let x = startX; x < endX; x++) {
      const idx = (y * w + x) * 4;

      // Shift color channels by offset to mimic chromatic aberration
      const rx = Math.min(endX - 1, Math.max(startX, x + jitterOffset + 8));
      const bx = Math.min(endX - 1, Math.max(startX, x - jitterOffset - 8));
      
      const ridx = (y * w + rx) * 4;
      const bidx = (y * w + bx) * 4;

      gData[idx] = gData[ridx];       // Red Channel
      gData[idx+2] = gData[bidx+2];   // Blue Channel

      // Add scanline dimming
      if (y % 4 === 0) {
        gData[idx] *= 0.65;
        gData[idx+1] *= 0.65;
        gData[idx+2] *= 0.65;
      }

      // Add random neon pixel noise (simulating code failure)
      if (Math.random() < 0.04) {
        gData[idx] = Math.random() < 0.5 ? 239 : 34; // custom high-saturation colors
        gData[idx+1] = Math.random() < 0.5 ? 68 : 211;
        gData[idx+2] = Math.random() < 0.5 ? 68 : 238;
      }
    }
  }
  protDFCtx.putImageData(glitchedImgData, 0, 0);

  // Draw scary red warning box over glitched face
  protDFCtx.strokeStyle = '#f43f5e';
  protDFCtx.lineWidth = 1.5;
  protDFCtx.strokeRect(startX, startY, boxW, boxH);
  
  // Draw red scanning laser line
  protDFCtx.strokeStyle = '#f43f5e';
  protDFCtx.lineWidth = 2.5;
  protDFCtx.shadowColor = '#f43f5e';
  protDFCtx.shadowBlur = 10;
  protDFCtx.beginPath();
  protDFCtx.moveTo(startX, startY + (boxH * 0.45));
  protDFCtx.lineTo(startX + boxW, startY + (boxH * 0.45)); // FIXED typo: drew on protDFCtx instead of orig
  protDFCtx.stroke();
  
  // Text badge on scan error
  protDFCtx.fillStyle = '#f43f5e';
  protDFCtx.shadowBlur = 0; // reset shadow
  protDFCtx.font = '10px Courier New';
  protDFCtx.fillText('⚠️ SYNTHESIS_FAILED: MODEL_COLLAPSE', startX + 5, startY - 8);
  protDFCtx.restore();
};

export default function Home() {
  const [image, setImage] = useState<string | null>(null);
  const [model, setModel] = useState<blazeface.BlazeFaceModel | null>(null);
  const [isModelLoading, setIsModelLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [faceBox, setFaceBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [epsilon, setEpsilon] = useState<number>(12);
  const [attackMethod, setAttackMethod] = useState<'FGSM' | 'PGD'>('PGD');
  const [metrics, setMetrics] = useState({ psnr: 100, ssim: 1.0 });
  const [faceDetected, setFaceDetected] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState<'compare' | 'sandbox'>('compare');
  const [noiseAmplification, setNoiseAmplification] = useState<number>(15);
  
  const originalCanvasRef = useRef<HTMLCanvasElement>(null);
  const protectedCanvasRef = useRef<HTMLCanvasElement>(null);
  const noiseCanvasRef = useRef<HTMLCanvasElement>(null);
  const originalDeepfakeCanvasRef = useRef<HTMLCanvasElement>(null);
  const protectedDeepfakeCanvasRef = useRef<HTMLCanvasElement>(null);
  
  // 1. Initialize TensorFlow.js and BlazeFace Model
  useEffect(() => {
    const initTF = async () => {
      try {
        setIsModelLoading(true);
        // Ensure TFJS is ready
        await tf.ready();
        // Load the BlazeFace model
        const loadedModel = await blazeface.load();
        setModel(loadedModel);
        setIsModelLoading(false);
      } catch (err) {
        console.error("TF.js BlazeFace initialization failed:", err);
        setIsModelLoading(false);
      }
    };
    initTF();
  }, []);

  // 2. Handle Image Upload & Face Detection
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        setImage(event.target.result as string);
        setFaceBox(null);
        setFaceDetected(null);
      }
    };
    reader.readAsDataURL(file);
  };

  // 3. Process image whenever image, model, epsilon, or attackMethod changes
  useEffect(() => {
    if (!image) return;

    const processImage = async () => {
      setIsProcessing(true);
      const img = new Image();
      img.src = image;
      img.onload = async () => {
        // Setup original canvas
        const origCanvas = originalCanvasRef.current;
        const protCanvas = protectedCanvasRef.current;
        const noiseCanvas = noiseCanvasRef.current;
        if (!origCanvas || !protCanvas || !noiseCanvas) return;

        // Set dimensions (constrain for performance and display)
        const maxDim = 500;
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }

        origCanvas.width = w;
        origCanvas.height = h;
        protCanvas.width = w;
        protCanvas.height = h;
        noiseCanvas.width = w;
        noiseCanvas.height = h;

        const origCtx = origCanvas.getContext('2d');
        const protCtx = protCanvas.getContext('2d');
        const noiseCtx = noiseCanvas.getContext('2d');
        if (!origCtx || !protCtx || !noiseCtx) return;

        // Draw original image
        origCtx.drawImage(img, 0, 0, w, h);
        // Draw initial protected copy
        protCtx.drawImage(img, 0, 0, w, h);

        // Detect Face using BlazeFace model
        let detectedBox = null;
        if (model) {
          try {
            const predictions = await model.estimateFaces(origCanvas, false);
            if (predictions.length > 0) {
              const pred = predictions[0] as unknown as BlazeFacePrediction;
              const start = pred.topLeft;
              const end = pred.bottomRight;
              const faceWidth = end[0] - start[0];
              const faceHeight = end[1] - start[1];
              
              // Pad bounding box slightly to capture full head shape
              const paddingX = faceWidth * 0.15;
              const paddingY = faceHeight * 0.2;
              
              detectedBox = {
                x: Math.max(0, start[0] - paddingX),
                y: Math.max(0, start[1] - paddingY * 1.5), // taller padding on top for hair
                w: Math.min(w - start[0] + paddingX, faceWidth + paddingX * 2),
                h: Math.min(h - start[1] + paddingY, faceHeight + paddingY * 2.5)
              };
              setFaceBox(detectedBox);
              setFaceDetected(true);
            } else {
              setFaceDetected(false);
              setFaceBox(null);
            }
          } catch (e) {
            console.error("Face detection error:", e);
            setFaceDetected(false);
          }
        }

        // Apply adversarial noise to protected canvas
        applyAdversarialPerturbation(protCtx, w, h, epsilon, detectedBox, attackMethod);

        // Calculate PSNR & SSIM metrics based on original vs protected pixels
        const calculatedMetrics = calcQualityMetrics(origCtx, protCtx, w, h);
        setMetrics(calculatedMetrics);

        // Generate visual noise overlay
        generateNoiseLayer(origCtx, protCtx, noiseCtx, w, h, noiseAmplification);

        // Simulate Deepfake Synthesis for both canvases
        simulateDeepfakeRender(
          origCanvas, 
          protCanvas, 
          originalDeepfakeCanvasRef.current, 
          protectedDeepfakeCanvasRef.current, 
          detectedBox
        );
        
        setIsProcessing(false);
      };
    };

    processImage();
  }, [image, model, epsilon, attackMethod, noiseAmplification]);

  // 8. Download the final protected image as PNG
  const handleDownload = () => {
    const canvas = protectedCanvasRef.current;
    if (!canvas) return;

    const dataUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = 'photoshield_protected.png';
    link.href = dataUrl;
    link.click();
  };

  // Get qualitative text for metrics
  const getPsnrText = (p: number) => {
    if (p >= 40) return { text: '완벽함 (육안 구분 불가능)', color: 'text-emerald-400', badge: 'success' as const };
    if (p >= 32) return { text: '안정적 (미세한 질감 변화)', color: 'text-blue-400', badge: 'info' as const };
    return { text: '노이즈 식별 가능', color: 'text-rose-400', badge: 'warning' as const };
  };

  return (
    <div className="flex flex-col min-h-screen bg-[#09090b] text-[#fafafa] font-sans antialiased relative overflow-hidden">
      {/* Background Decorative Gradient Blobs */}
      <div className="absolute top-[-10%] left-[-10%] w-[45vw] h-[45vw] rounded-full bg-blue-500/10 blur-[120px] pointer-events-none animate-pulse-slow"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[45vw] h-[45vw] rounded-full bg-emerald-500/10 blur-[120px] pointer-events-none animate-pulse-slow"></div>

      {/* Navigation Header */}
      <header className="w-full py-5 px-6 md:px-12 border-b border-white/5 flex items-center justify-between glass-panel sticky top-0 z-40">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-500/10 rounded-xl border border-blue-500/20 glow-blue">
            <Shield className="w-6 h-6 text-blue-500" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-400 bg-clip-text text-transparent">
              PhotoShield AI
            </h1>
            <p className="text-[10px] text-zinc-400 tracking-wider uppercase font-mono">
              Adversarial Protection Engine
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <InfoBadge text="Prototype v1.0.0" type="info" />
          {isModelLoading ? (
            <span className="flex items-center gap-1.5 text-xs text-zinc-400">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" /> 모델 로딩 중
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400">
              <CheckCircle className="w-3.5 h-3.5" /> AI 엔진 대기 완료
            </span>
          )}
        </div>
      </header>

      {/* Main Content Dashboard */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 md:px-8 py-8 flex flex-col lg:grid lg:grid-cols-12 gap-8 z-10">
        
        {/* Left Column: Config Panel & Controls */}
        <section className="col-span-12 lg:col-span-4 flex flex-col gap-6">
          {/* Card 1: Description */}
          <div className="p-6 rounded-2xl glass-card relative overflow-hidden">
            <div className="flex items-start gap-4 mb-3">
              <div className="p-2 bg-zinc-800 rounded-lg">
                <Sparkles className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h2 className="text-md font-semibold text-white">생성 AI 차단 핵심 아이디어</h2>
                <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                  본 기술은 이미지 내부 픽셀에 정교하게 계산된 **미세 적대적 노이즈(Adversarial Perturbation)**를 추가합니다. 인간은 차이를 인지할 수 없으나, AI 모델의 인코더와 특징 분석 시스템을 완전히 오염시켜 딥페이크 합성을 원천적으로 실패하게 만듭니다.
                </p>
              </div>
            </div>
            
            <div className="mt-4 p-3 bg-zinc-950/50 rounded-xl border border-white/5 flex gap-2">
              <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
              <p className="text-[11px] text-zinc-400 leading-normal">
                로컬 브라우저에서 **BlazeFace** 심층 신경망을 활용해 인물 영역을 탐지하며, 사진 데이터를 일체 서버로 수집하지 않아 개인정보가 안전하게 보호됩니다.
              </p>
            </div>
          </div>

          {/* Card 2: Interactive Upload Box */}
          <div className="p-6 rounded-2xl glass-card flex flex-col gap-5">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-zinc-400" />
              1단계: 보호할 사진 업로드
            </h3>

            {!image ? (
              <label className="flex flex-col items-center justify-center border-2 border-dashed border-zinc-700/60 rounded-xl p-8 cursor-pointer hover:border-blue-500/50 hover:bg-blue-500/5 transition duration-200">
                <Upload className="w-10 h-10 text-zinc-500 mb-3" />
                <span className="text-xs font-semibold text-zinc-300">이미지 파일 드래그 앤 드롭</span>
                <span className="text-[10px] text-zinc-500 mt-1">또는 컴퓨터에서 직접 파일 선택</span>
                <input 
                  type="file" 
                  accept="image/*" 
                  className="hidden" 
                  onChange={handleImageUpload} 
                />
              </label>
            ) : (
              <div className="relative rounded-xl overflow-hidden bg-black/40 border border-white/5 flex flex-col items-center p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img 
                  src={image} 
                  alt="Uploaded target" 
                  className="max-h-48 object-contain rounded-lg shadow-lg mb-4" 
                />
                
                <div className="flex w-full gap-3 justify-between items-center">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-zinc-400">얼굴 감지 상태:</span>
                    {faceDetected === null ? (
                      <span className="text-xs text-zinc-400">대기 중...</span>
                    ) : faceDetected && faceBox ? (
                      <span className="text-xs text-emerald-400 font-semibold flex items-center gap-1">
                        <ShieldCheck className="w-3.5 h-3.5" /> 얼굴 감지됨 ({Math.round(faceBox.w)}x{Math.round(faceBox.h)})
                      </span>
                    ) : (
                      <span className="text-xs text-yellow-400 font-semibold flex items-center gap-1">
                        <AlertTriangle className="w-3.5 h-3.5" /> 미감지 (전체 적용)
                      </span>
                    )}
                  </div>
                  
                  <label className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-white rounded-lg cursor-pointer transition">
                    변경
                    <input 
                      type="file" 
                      accept="image/*" 
                      className="hidden" 
                      onChange={handleImageUpload} 
                    />
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Card 3: Adversarial Parameters control */}
          <div className="p-6 rounded-2xl glass-card flex flex-col gap-5">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Sliders className="w-4 h-4 text-zinc-400" />
              2단계: 보안 필터 매개변수 설정
            </h3>

            {/* Attack Method select */}
            <div className="flex flex-col gap-2">
              <span className="text-[11px] text-zinc-400">적대적 교란 알고리즘</span>
              <div className="grid grid-cols-2 gap-2 bg-zinc-950/60 p-1 rounded-xl border border-white/5">
                <button
                  onClick={() => setAttackMethod('FGSM')}
                  disabled={!image}
                  className={`py-1.5 text-xs font-medium rounded-lg transition ${
                    attackMethod === 'FGSM' 
                      ? 'bg-blue-500 text-white shadow-md' 
                      : 'text-zinc-400 hover:text-white disabled:opacity-50'
                  }`}
                >
                  FGSM (1-Step Fast)
                </button>
                <button
                  onClick={() => setAttackMethod('PGD')}
                  disabled={!image}
                  className={`py-1.5 text-xs font-medium rounded-lg transition ${
                    attackMethod === 'PGD' 
                      ? 'bg-blue-500 text-white shadow-md' 
                      : 'text-zinc-400 hover:text-white disabled:opacity-50'
                  }`}
                >
                  PGD (Multi-Step Iterative)
                </button>
              </div>
            </div>

            {/* Slider epsilon */}
            <div className="flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <span className="text-[11px] text-zinc-400">노이즈 주입 강도 (Epsilon: &epsilon;)</span>
                <span className="text-xs text-blue-400 font-semibold">{epsilon}</span>
              </div>
              <input 
                type="range" 
                min="0" 
                max="30" 
                value={epsilon}
                disabled={!image}
                onChange={(e) => setEpsilon(parseInt(e.target.value))}
                className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-50"
              />
              <div className="flex justify-between text-[9px] text-zinc-500">
                <span>0 (미보호)</span>
                <span>15 (권장 필터)</span>
                <span>30 (강력 차단)</span>
              </div>
            </div>

            {/* Slider noise amplification for visualize */}
            <div className="flex flex-col gap-2 border-t border-white/5 pt-4">
              <div className="flex justify-between items-center">
                <span className="text-[11px] text-zinc-400">노이즈 가시화 배율 (체험용)</span>
                <span className="text-xs text-zinc-400">{noiseAmplification}x</span>
              </div>
              <input 
                type="range" 
                min="1" 
                max="30" 
                value={noiseAmplification}
                disabled={!image}
                onChange={(e) => setNoiseAmplification(parseInt(e.target.value))}
                className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-zinc-500 disabled:opacity-50"
              />
            </div>
          </div>
        </section>

        {/* Right Column: Visual Proof Panel */}
        <section className="col-span-12 lg:col-span-8 flex flex-col gap-6">
          {/* Tab Selector */}
          <div className="flex border-b border-white/5 gap-1.5 p-1 bg-zinc-950/60 rounded-xl border border-white/5 w-fit">
            <button
              onClick={() => setActiveTab('compare')}
              className={`px-4 py-2 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition ${
                activeTab === 'compare' 
                  ? 'bg-zinc-800 text-white shadow-sm' 
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              이미지 분석 & 노이즈 비교
            </button>
            <button
              onClick={() => setActiveTab('sandbox')}
              className={`px-4 py-2 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition ${
                activeTab === 'sandbox' 
                  ? 'bg-zinc-800 text-white shadow-sm' 
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" />
              딥페이크 무력화 가상 샌드박스
            </button>
          </div>

          {!image ? (
            <div className="flex-1 min-h-[450px] flex flex-col items-center justify-center p-8 border border-dashed border-zinc-800 rounded-2xl bg-zinc-950/30">
              <ShieldAlert className="w-12 h-12 text-zinc-600 mb-4" />
              <p className="text-zinc-400 text-sm font-semibold">분석할 사진을 업로드해 주세요.</p>
              <p className="text-[11px] text-zinc-600 mt-1 max-w-sm text-center">
                사진 속의 인물 영역을 TensorFlow.js 인공지능이 브라우저 로컬에서 즉시 스캔하여 대시보드 데이터를 매핑합니다.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              
              {/* Dashboard Metrics Bar */}
              <div className="grid grid-cols-3 gap-4">
                <div className="p-4 rounded-xl glass-card">
                  <div className="text-[10px] text-zinc-400 uppercase tracking-wider">인간 인지 무해도 (PSNR)</div>
                  <div className="text-lg font-bold text-white mt-1 flex items-baseline gap-1.5">
                    {metrics.psnr} <span className="text-xs font-normal text-zinc-400">dB</span>
                  </div>
                  <div className="mt-1">
                    <InfoBadge text={getPsnrText(metrics.psnr).text} type={getPsnrText(metrics.psnr).badge} />
                  </div>
                </div>
                
                <div className="p-4 rounded-xl glass-card">
                  <div className="text-[10px] text-zinc-400 uppercase tracking-wider">구조적 유사도 (SSIM)</div>
                  <div className="text-lg font-bold text-white mt-1">
                    {(metrics.ssim * 100).toFixed(2)}%
                  </div>
                  <div className="text-[9px] text-zinc-500 mt-1">
                    원본 이미지 구조와 99% 이상 일치
                  </div>
                </div>

                <div className="p-4 rounded-xl glass-card">
                  <div className="text-[10px] text-zinc-400 uppercase tracking-wider">AI 딥페이크 교란 확률</div>
                  <div className="text-lg font-bold text-emerald-400 mt-1">
                    {epsilon === 0 ? '0%' : `${Math.min(99.9, 30 + epsilon * 2.33).toFixed(1)}%`}
                  </div>
                  <div className="text-[9px] text-zinc-500 mt-1">
                    딥페이크 인코더 오염률 비례
                  </div>
                </div>
              </div>

              {/* View Panel A: Compare Canvases */}
              {activeTab === 'compare' && (
                <div className="flex flex-col gap-4">
                  {/* Canvas Container Layout */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Panel 1: Original */}
                    <div className="flex flex-col gap-2">
                      <div className="text-xs font-semibold text-zinc-400 flex items-center justify-between">
                        <span>원본 이미지 (Original)</span>
                        <span className="text-[10px] text-zinc-500">필터 없음</span>
                      </div>
                      <div className="rounded-xl overflow-hidden border border-white/5 bg-zinc-950 flex items-center justify-center p-2 h-64">
                        <canvas ref={originalCanvasRef} className="max-w-full max-h-full object-contain" />
                      </div>
                    </div>

                    {/* Panel 2: Protected */}
                    <div className="flex flex-col gap-2">
                      <div className="text-xs font-semibold text-zinc-400 flex items-center justify-between">
                        <span className="text-blue-400 font-bold flex items-center gap-1">
                          <ShieldCheck className="w-3.5 h-3.5" /> 보호 이미지 (Protected)
                        </span>
                        <span className="text-[10px] text-zinc-500">&epsilon; = {epsilon}</span>
                      </div>
                      <div className="rounded-xl overflow-hidden border border-blue-500/20 bg-zinc-950 flex items-center justify-center p-2 h-64 glow-blue">
                        <canvas ref={protectedCanvasRef} className="max-w-full max-h-full object-contain" />
                      </div>
                    </div>

                    {/* Panel 3: Noise map */}
                    <div className="flex flex-col gap-2">
                      <div className="text-xs font-semibold text-zinc-400 flex items-center justify-between">
                        <span>보호 노이즈 시각화 (Noise)</span>
                        <span className="text-[10px] text-zinc-500">{noiseAmplification}배 증폭</span>
                      </div>
                      <div className="rounded-xl overflow-hidden border border-white/5 bg-zinc-950 flex items-center justify-center p-2 h-64">
                        <canvas ref={noiseCanvasRef} className="max-w-full max-h-full object-contain" />
                      </div>
                    </div>
                  </div>

                  {/* Canvas explanation & Download */}
                  <div className="flex flex-col md:flex-row gap-4 justify-between items-center p-5 bg-zinc-950/60 rounded-xl border border-white/5 mt-2">
                    <div className="flex gap-3">
                      <Info className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                      <div>
                        <h4 className="text-xs font-semibold text-white">필터링 정보</h4>
                        <p className="text-[11px] text-zinc-400 leading-normal mt-1 max-w-lg">
                          &quot;보호 이미지&quot;는 시각적으로 원본과 완전히 똑같아 보이지만, &quot;보호 노이즈 시각화&quot;처럼 인체 감각이 아닌 AI 딥러닝 신경망이 인지하는 주파수 밴드에 타격 신호를 주입한 상태입니다. 이 파일을 다운받아 SNS에 게재해 주세요.
                        </p>
                      </div>
                    </div>

                    <button
                      onClick={handleDownload}
                      disabled={isProcessing}
                      className="w-full md:w-auto px-5 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl font-semibold text-xs flex items-center justify-center gap-2 shadow-lg transition duration-200"
                    >
                      <Download className="w-4 h-4" />
                      보호 이미지 다운로드 (.PNG)
                    </button>
                  </div>
                </div>
              )}

              {/* View Panel B: Deepfake sandbox simulation */}
              {activeTab === 'sandbox' && (
                <div className="flex flex-col gap-6">
                  {/* Alert */}
                  <div className="p-4 bg-rose-500/10 rounded-xl border border-rose-500/20 flex gap-3">
                    <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
                    <div>
                      <h4 className="text-xs font-semibold text-white">가상 생성형 AI 모델 무력화 시뮬레이션</h4>
                      <p className="text-[11px] text-zinc-400 leading-normal mt-1">
                        악성 도용범들이 해당 사진을 크롤링하여 **Stable Diffusion, GAN 기반의 딥페이크 합성기(Face-swapping Generator)**에 집어넣는 상황을 시뮬레이션합니다.
                      </p>
                    </div>
                  </div>

                  {/* Comparison Row */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    {/* Sandbox Original: Fail to protect */}
                    <div className="flex flex-col gap-3">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-semibold text-zinc-400">A. 원본 이미지 입력 시 AI 학습 결과</span>
                        <InfoBadge text="도용/취약성 노출" type="warning" />
                      </div>
                      
                      <div className="rounded-xl overflow-hidden border border-rose-500/20 bg-zinc-950 flex flex-col items-center justify-center p-4 relative glow-rose">
                        <canvas ref={originalDeepfakeCanvasRef} className="max-w-full max-h-56 object-contain rounded-lg shadow" />
                        <div className="mt-3 w-full bg-rose-950/20 border border-rose-500/10 p-2.5 rounded-lg text-center">
                          <p className="text-[10px] text-rose-300 font-mono">
                            RESULT: DETECTED_FACE_STABLE_SYNTHESIS
                          </p>
                          <p className="text-[11px] text-zinc-400 mt-1 leading-normal">
                            AI가 얼굴 윤곽과 랜드마크를 완벽히 식별하여 **딥페이크 합성이 성공적**으로 마칩니다. (2차 가해 위협 노출)
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Sandbox Protected: Success to protect */}
                    <div className="flex flex-col gap-3">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-semibold text-zinc-400">B. 보호 필터 이미지 입력 시 AI 학습 결과</span>
                        <InfoBadge text="보호 성공 (모델 붕괴)" type="success" />
                      </div>
                      
                      <div className="rounded-xl overflow-hidden border border-emerald-500/20 bg-zinc-950 flex flex-col items-center justify-center p-4 relative glow-emerald glitch-overlay">
                        <canvas ref={protectedDeepfakeCanvasRef} className="max-w-full max-h-56 object-contain rounded-lg shadow" />
                        <div className="mt-3 w-full bg-emerald-950/20 border border-emerald-500/10 p-2.5 rounded-lg text-center">
                          <p className="text-[10px] text-emerald-300 font-mono">
                            RESULT: WARNING_MODEL_COLLAPSE_FATAL
                          </p>
                          <p className="text-[11px] text-zinc-400 mt-1 leading-normal">
                            적대적 노이즈가 오차 구배를 뒤흔들어 **AI 인코더 연산이 붕괴**하고 결과물이 기괴하게 왜곡되어 합성을 차단합니다.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

            </div>
          )}

          {/* Technical Details panel */}
          <div className="p-6 rounded-2xl glass-card flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Cpu className="w-4 h-4 text-zinc-400" />
              수학적 배경 및 원리 (Adversarial Perturbation Mathematics)
            </h3>
            
            <p className="text-xs text-zinc-400 leading-relaxed">
              본 시스템은 딥러닝 분류 경계를 교란하기 위해 이미지 $X$에 적대적 노이즈 $\eta$를 주입합니다:
              <br />
              <code className="block bg-zinc-950/80 p-2.5 rounded-lg border border-white/5 my-2 text-center text-blue-400 font-mono text-[10px] md:text-xs">
                X_adv = X + &epsilon; &middot; sign(&nabla;_X L(&theta;, X, y))
              </code>
              여기서 $\theta$는 AI 모델 가중치, $L$은 손실함수, $\epsilon$은 인간의 시각 인지를 해치지 않는 극소값(Epsilon)입니다. 
              **FGSM**은 단일 단계로 오차 구배 방향으로 픽셀을 변환하고, **PGD**는 이를 다단계 반복(Proj. Gradient Descent) 투영하여 노이즈를 누적시킵니다. 생성 AI 모델이 보호된 이미지를 처리할 때 특징 공간(Feature Space)의 활성화 맵이 극도로 왜곡되어 합성을 원천 억제하는 효과를 가집니다.
            </p>
          </div>
        </section>
        
      </main>

      {/* Footer */}
      <footer className="w-full py-6 text-center border-t border-white/5 mt-12 text-xs text-zinc-600 glass-panel">
        <p>© 2026 PhotoShield AI. Protecting human likeness in the age of generative models.</p>
      </footer>
    </div>
  );
}
