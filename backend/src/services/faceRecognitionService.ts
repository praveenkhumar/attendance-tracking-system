import * as faceapi from "face-api.js";
import { Canvas, Image, createCanvas, loadImage } from "canvas";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { appConfig } from "../utils/config";

// Patch face-api.js to work with node-canvas
(faceapi.env as any).monkeyPatch({
  Canvas,
  Image,
  createCanvas,
  loadImage,
});

export interface FaceDescriptor {
  descriptor: Float32Array;
  detection: faceapi.FaceDetection;
  landmarks: faceapi.FaceLandmarks68;
}

export interface FaceMatch {
  userId: string;
  distance: number;
  confidence: number;
}

export class FaceRecognitionService {
  private static instance: FaceRecognitionService;
  private isInitialized = false;
  private modelsPath: string;

  private constructor() {
    this.modelsPath = path.join(__dirname, "../../../models");
  }

  public static getInstance(): FaceRecognitionService {
    if (!FaceRecognitionService.instance) {
      FaceRecognitionService.instance = new FaceRecognitionService();
    }
    return FaceRecognitionService.instance;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.info("Face recognition service already initialized");
      return;
    }

    try {
      logger.info("Initializing face recognition service...");

      // Create models directory if it doesn't exist
      if (!fs.existsSync(this.modelsPath)) {
        fs.mkdirSync(this.modelsPath, { recursive: true });
      }

      // Load face recognition models
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromDisk(this.modelsPath),
        faceapi.nets.faceLandmark68Net.loadFromDisk(this.modelsPath),
        faceapi.nets.faceRecognitionNet.loadFromDisk(this.modelsPath),
      ]);

      this.isInitialized = true;
      logger.info("Face recognition service initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize face recognition service:", error);

      // If models don't exist, download them
      await this.downloadModels();

      // Try again
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromDisk(this.modelsPath),
        faceapi.nets.faceLandmark68Net.loadFromDisk(this.modelsPath),
        faceapi.nets.faceRecognitionNet.loadFromDisk(this.modelsPath),
      ]);

      this.isInitialized = true;
      logger.info(
        "Face recognition service initialized successfully after downloading models"
      );
    }
  }

  private async downloadModels(): Promise<void> {
    logger.info("Downloading face recognition models...");

    // For production, you should download these models and include them in your deployment
    // For this demo, we'll create placeholder functionality
    const models = [
      "ssd_mobilenetv1_model-weights_manifest.json",
      "ssd_mobilenetv1_model-shard1",
      "face_landmark_68_model-weights_manifest.json",
      "face_landmark_68_model-shard1",
      "face_recognition_model-weights_manifest.json",
      "face_recognition_model-shard1",
    ];

    // Create empty model files for demo purposes
    // In production, download actual models from face-api.js GitHub releases
    for (const model of models) {
      const modelPath = path.join(this.modelsPath, model);
      if (!fs.existsSync(modelPath)) {
        fs.writeFileSync(modelPath, "{}");
      }
    }

    logger.info("Model files created (placeholder for demo)");
  }

  async extractFaceDescriptor(
    imagePath: string
  ): Promise<FaceDescriptor | null> {
    if (!this.isInitialized) {
      throw new Error("Face recognition service not initialized");
    }

    try {
      logger.debug(`Extracting face descriptor from: ${imagePath}`);

      // Load image
      const image = await loadImage(imagePath);

      // Detect face with landmarks and descriptor
      const detection = await faceapi
        .detectSingleFace(image as any)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) {
        logger.warn(`No face detected in image: ${imagePath}`);
        return null;
      }

      logger.debug("Face descriptor extracted successfully");

      return {
        descriptor: detection.descriptor,
        detection: detection.detection,
        landmarks: detection.landmarks,
      };
    } catch (error) {
      logger.error("Error extracting face descriptor:", error);
      return null;
    }
  }

  async extractFaceDescriptorFromBuffer(
    imageBuffer: Buffer
  ): Promise<FaceDescriptor | null> {
    if (!this.isInitialized) {
      throw new Error("Face recognition service not initialized");
    }

    try {
      logger.debug("Extracting face descriptor from buffer");

      // Load image from buffer
      const image = await loadImage(imageBuffer);

      // Detect face with landmarks and descriptor
      const detection = await faceapi
        .detectSingleFace(image as any)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) {
        logger.warn("No face detected in image buffer");
        return null;
      }

      logger.debug("Face descriptor extracted from buffer successfully");

      return {
        descriptor: detection.descriptor,
        detection: detection.detection,
        landmarks: detection.landmarks,
      };
    } catch (error) {
      logger.error("Error extracting face descriptor from buffer:", error);
      return null;
    }
  }

  calculateDistance(
    descriptor1: Float32Array | number[],
    descriptor2: Float32Array | number[]
  ): number {
    try {
      // Convert to Float32Array if needed
      const desc1 =
        descriptor1 instanceof Float32Array
          ? descriptor1
          : new Float32Array(descriptor1);
      const desc2 =
        descriptor2 instanceof Float32Array
          ? descriptor2
          : new Float32Array(descriptor2);

      // Calculate Euclidean distance
      let sum = 0;
      for (let i = 0; i < desc1.length; i++) {
        const diff = desc1[i] - desc2[i];
        sum += diff * diff;
      }

      return Math.sqrt(sum);
    } catch (error) {
      logger.error("Error calculating distance:", error);
      return 1.0; // Return maximum distance on error
    }
  }

  findBestMatch(
    inputDescriptor: Float32Array | number[],
    knownDescriptors: Record<string, number[]>
  ): FaceMatch | null {
    try {
      let bestMatch: FaceMatch | null = null;
      let minDistance = Infinity;

      for (const [userId, descriptor] of Object.entries(knownDescriptors)) {
        const distance = this.calculateDistance(inputDescriptor, descriptor);

        if (distance < minDistance) {
          minDistance = distance;
          bestMatch = {
            userId,
            distance,
            confidence: Math.max(0, 1 - distance), // Convert distance to confidence score
          };
        }
      }

      // Check if the best match meets our threshold
      if (bestMatch && bestMatch.distance < 1 - appConfig.face.matchThreshold) {
        logger.debug(
          `Face match found: User ${bestMatch.userId} with confidence ${bestMatch.confidence}`
        );
        return bestMatch;
      }

      logger.debug("No face match found above threshold");
      return null;
    } catch (error) {
      logger.error("Error finding best match:", error);
      return null;
    }
  }

  async validateFaceQuality(imagePath: string): Promise<{
    isValid: boolean;
    confidence: number;
    issues: string[];
  }> {
    try {
      const image = await loadImage(imagePath);
      const detection = await faceapi.detectSingleFace(image as any);

      if (!detection) {
        return {
          isValid: false,
          confidence: 0,
          issues: ["No face detected"],
        };
      }

      const issues: string[] = [];
      let confidence = detection.score;

      // Check face size (should not be too small)
      const faceSize = Math.min(detection.box.width, detection.box.height);
      if (faceSize < 100) {
        issues.push("Face too small");
        confidence *= 0.8;
      }

      // Check detection confidence
      if (detection.score < 0.8) {
        issues.push("Low detection confidence");
        confidence *= 0.9;
      }

      // Face should be centered reasonably
      const imageDimensions = {
        width: (image as any).width,
        height: (image as any).height,
      };
      const faceCenterX = detection.box.x + detection.box.width / 2;
      const faceCenterY = detection.box.y + detection.box.height / 2;
      const imageCenter = {
        x: imageDimensions.width / 2,
        y: imageDimensions.height / 2,
      };

      const offsetX =
        Math.abs(faceCenterX - imageCenter.x) / imageDimensions.width;
      const offsetY =
        Math.abs(faceCenterY - imageCenter.y) / imageDimensions.height;

      if (offsetX > 0.3 || offsetY > 0.3) {
        issues.push("Face not well centered");
        confidence *= 0.9;
      }

      return {
        isValid: issues.length === 0 && confidence > 0.7,
        confidence,
        issues,
      };
    } catch (error) {
      logger.error("Error validating face quality:", error);
      return {
        isValid: false,
        confidence: 0,
        issues: ["Error processing image"],
      };
    }
  }

  async processMultipleFaceImages(
    imagePaths: string[]
  ): Promise<Float32Array | null> {
    try {
      const descriptors: Float32Array[] = [];

      for (const imagePath of imagePaths) {
        const faceData = await this.extractFaceDescriptor(imagePath);
        if (faceData) {
          descriptors.push(faceData.descriptor);
        }
      }

      if (descriptors.length === 0) {
        logger.warn("No valid face descriptors found in provided images");
        return null;
      }

      // Calculate average descriptor
      const avgDescriptor = new Float32Array(descriptors[0].length);

      for (let i = 0; i < avgDescriptor.length; i++) {
        let sum = 0;
        for (const descriptor of descriptors) {
          sum += descriptor[i];
        }
        avgDescriptor[i] = sum / descriptors.length;
      }

      logger.debug(
        `Processed ${descriptors.length} face images into average descriptor`
      );
      return avgDescriptor;
    } catch (error) {
      logger.error("Error processing multiple face images:", error);
      return null;
    }
  }

  isInitialized(): boolean {
    return this.isInitialized;
  }
}
