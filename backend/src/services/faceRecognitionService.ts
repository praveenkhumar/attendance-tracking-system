// backend/src/services/faceRecognitionService.ts
import * as faceapi from "face-api.js";
import { Canvas, Image, ImageData } from "canvas";
import { logger } from "../utils/logger";
import { cacheService } from "../utils/redis";
import { User, IUser } from "../models/User";
import path from "path";
import fs from "fs/promises";

// Monkey patch for face-api.js to work in Node.js
faceapi.env.monkeyPatch({ Canvas, Image, ImageData } as any);

export interface FaceMatch {
  userId: string;
  user: IUser;
  distance: number;
  confidence: number;
}

export interface FaceDetectionResult {
  detected: boolean;
  descriptor?: number[];
  confidence?: number;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export class FaceRecognitionService {
  private static instance: FaceRecognitionService;
  private isInitialized: boolean = false;
  private readonly CONFIDENCE_THRESHOLD = 0.6; // Minimum confidence for face matching
  private readonly FACE_DISTANCE_THRESHOLD = 0.4; // Maximum distance for face match

  private constructor() {}

  public static getInstance(): FaceRecognitionService {
    if (!FaceRecognitionService.instance) {
      FaceRecognitionService.instance = new FaceRecognitionService();
    }
    return FaceRecognitionService.instance;
  }

  /**
   * Initialize face-api.js models
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.info("Face recognition service already initialized");
      return;
    }

    try {
      const modelsPath = path.join(__dirname, "../../models/face-api");

      // Check if models directory exists
      try {
        await fs.access(modelsPath);
      } catch {
        logger.warn("Face-api models not found at:", modelsPath);
        logger.info("Please download face-api.js models to:", modelsPath);
        throw new Error("Face recognition models not found");
      }

      // Load face-api.js models
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromDisk(modelsPath),
        faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath),
        faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath),
        faceapi.nets.faceExpressionNet.loadFromDisk(modelsPath),
      ]);

      this.isInitialized = true;
      logger.info("Face recognition service initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize face recognition service:", error);
      throw error;
    }
  }

  /**
   * Extract face descriptor from image buffer
   */
  public async extractFaceDescriptor(
    imageBuffer: Buffer
  ): Promise<FaceDetectionResult> {
    if (!this.isInitialized) {
      throw new Error("Face recognition service not initialized");
    }

    try {
      // Convert buffer to image
      const img = await faceapi.fetchImage(imageBuffer as any);

      // Detect face with landmarks and descriptor
      const detection = await faceapi
        .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) {
        return {
          detected: false,
        };
      }

      return {
        detected: true,
        descriptor: Array.from(detection.descriptor),
        confidence: detection.detection.score,
        boundingBox: {
          x: detection.detection.box.x,
          y: detection.detection.box.y,
          width: detection.detection.box.width,
          height: detection.detection.box.height,
        },
      };
    } catch (error) {
      logger.error("Error extracting face descriptor:", error);
      throw new Error("Failed to process face image");
    }
  }

  /**
   * Extract multiple face descriptors for registration (more accurate)
   */
  public async extractMultipleFaceDescriptors(
    imageBuffers: Buffer[]
  ): Promise<number[] | null> {
    if (imageBuffers.length === 0) {
      throw new Error("No images provided");
    }

    const descriptors: number[][] = [];

    for (const buffer of imageBuffers) {
      const result = await this.extractFaceDescriptor(buffer);
      if (
        result.detected &&
        result.descriptor &&
        result.confidence! >= this.CONFIDENCE_THRESHOLD
      ) {
        descriptors.push(result.descriptor);
      }
    }

    if (descriptors.length === 0) {
      return null;
    }

    // Calculate average descriptor for better accuracy
    return this.calculateAverageDescriptor(descriptors);
  }

  /**
   * Find matching user by face descriptor
   */
  public async findMatchingUser(
    faceDescriptor: number[]
  ): Promise<FaceMatch | null> {
    try {
      // First try to get cached descriptors
      let cachedDescriptors = await cacheService.getAllFaceDescriptors();

      // If cache is empty, load from database and cache
      if (Object.keys(cachedDescriptors).length === 0) {
        cachedDescriptors = await this.loadAndCacheFaceDescriptors();
      }

      let bestMatch: FaceMatch | null = null;
      let minDistance = Infinity;

      for (const [userId, descriptor] of Object.entries(cachedDescriptors)) {
        const distance = this.calculateEuclideanDistance(
          faceDescriptor,
          descriptor
        );

        if (distance < this.FACE_DISTANCE_THRESHOLD && distance < minDistance) {
          const user = await User.findById(userId);
          if (user && user.isActive) {
            minDistance = distance;
            bestMatch = {
              userId,
              user,
              distance,
              confidence: 1 - distance, // Convert distance to confidence score
            };
          }
        }
      }

      return bestMatch;
    } catch (error) {
      logger.error("Error finding matching user:", error);
      throw new Error("Failed to match face");
    }
  }

  /**
   * Register new user face descriptor
   */
  public async registerUserFace(
    userId: string,
    descriptor: number[]
  ): Promise<void> {
    try {
      // Cache the descriptor
      await cacheService.cacheFaceDescriptor(userId, descriptor);

      logger.info(`Face descriptor registered for user: ${userId}`);
    } catch (error) {
      logger.error("Error registering user face:", error);
      throw new Error("Failed to register face");
    }
  }

  /**
   * Update user face descriptor
   */
  public async updateUserFace(
    userId: string,
    descriptor: number[]
  ): Promise<void> {
    try {
      // Update in cache
      await cacheService.cacheFaceDescriptor(userId, descriptor);

      logger.info(`Face descriptor updated for user: ${userId}`);
    } catch (error) {
      logger.error("Error updating user face:", error);
      throw new Error("Failed to update face");
    }
  }

  /**
   * Remove user face descriptor from cache
   */
  public async removeUserFace(userId: string): Promise<void> {
    try {
      await cacheService.del(`face_descriptors:${userId}`);
      logger.info(`Face descriptor removed for user: ${userId}`);
    } catch (error) {
      logger.error("Error removing user face:", error);
      throw new Error("Failed to remove face");
    }
  }

  /**
   * Validate face image quality
   */
  public async validateFaceImage(imageBuffer: Buffer): Promise<{
    isValid: boolean;
    issues: string[];
    quality: number;
  }> {
    const issues: string[] = [];
    let quality = 1.0;

    try {
      const result = await this.extractFaceDescriptor(imageBuffer);

      if (!result.detected) {
        issues.push("No face detected in image");
        return { isValid: false, issues, quality: 0 };
      }

      if (result.confidence! < this.CONFIDENCE_THRESHOLD) {
        issues.push("Face detection confidence too low");
        quality *= result.confidence!;
      }

      // Check face size (bounding box should be reasonable)
      if (result.boundingBox) {
        const faceArea = result.boundingBox.width * result.boundingBox.height;
        if (faceArea < 5000) {
          // Minimum face area in pixels
          issues.push("Face too small in image");
          quality *= 0.5;
        }
      }

      return {
        isValid: issues.length === 0,
        issues,
        quality,
      };
    } catch (error) {
      issues.push("Failed to process image");
      return { isValid: false, issues, quality: 0 };
    }
  }

  /**
   * Load all face descriptors from database and cache them
   */
  private async loadAndCacheFaceDescriptors(): Promise<{
    [userId: string]: number[];
  }> {
    try {
      const users = await User.find({ isActive: true }, "faceDescriptor");
      const descriptors: { [userId: string]: number[] } = {};

      for (const user of users) {
        if (user.faceDescriptor && user.faceDescriptor.length === 128) {
          descriptors[user._id.toString()] = user.faceDescriptor;
          // Cache individual descriptor
          await cacheService.cacheFaceDescriptor(
            user._id.toString(),
            user.faceDescriptor
          );
        }
      }

      logger.info(
        `Loaded and cached ${Object.keys(descriptors).length} face descriptors`
      );
      return descriptors;
    } catch (error) {
      logger.error("Error loading face descriptors:", error);
      throw error;
    }
  }

  /**
   * Calculate average descriptor from multiple descriptors
   */
  private calculateAverageDescriptor(descriptors: number[][]): number[] {
    if (descriptors.length === 0) {
      throw new Error("No descriptors provided");
    }

    const descriptorLength = descriptors[0].length;
    const average = new Array(descriptorLength).fill(0);

    for (const descriptor of descriptors) {
      for (let i = 0; i < descriptorLength; i++) {
        average[i] += descriptor[i];
      }
    }

    for (let i = 0; i < descriptorLength; i++) {
      average[i] /= descriptors.length;
    }

    return average;
  }

  /**
   * Calculate Euclidean distance between two face descriptors
   */
  private calculateEuclideanDistance(desc1: number[], desc2: number[]): number {
    if (desc1.length !== desc2.length) {
      throw new Error("Descriptors must have the same length");
    }

    let sum = 0;
    for (let i = 0; i < desc1.length; i++) {
      const diff = desc1[i] - desc2[i];
      sum += diff * diff;
    }

    return Math.sqrt(sum);
  }

  /**
   * Get service health status
   */
  public getHealthStatus(): {
    initialized: boolean;
    modelsLoaded: boolean;
    thresholds: {
      confidence: number;
      distance: number;
    };
  } {
    return {
      initialized: this.isInitialized,
      modelsLoaded: this.isInitialized,
      thresholds: {
        confidence: this.CONFIDENCE_THRESHOLD,
        distance: this.FACE_DISTANCE_THRESHOLD,
      },
    };
  }
}

// Export singleton instance
export const faceRecognitionService = FaceRecognitionService.getInstance();
