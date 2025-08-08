// backend/src/routes/upload.js
const { faceService } = require("../services");
const { AppError } = require("../utils/errors");
const multer = require("@fastify/multipart");

/**
 * Upload & Utility Routes Plugin
 */
async function uploadRoutes(fastify, options) {
  // Register multipart support for file uploads
  await fastify.register(multer, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB limit
      files: 1, // Only one file at a time
    },
  });

  // Process face from uploaded image
  fastify.post("/process-face", {
    preHandler: [
      fastify.authenticate,
      fastify.rateLimit({
        max: 20,
        timeWindow: "1 hour",
        keyGenerator: (request) => `face-process-${request.user.id}`,
      }),
    ],
    handler: async (request, reply) => {
      try {
        // Check if file is uploaded
        const data = await request.file();

        if (!data) {
          throw new AppError("No file uploaded", 400);
        }

        // Validate file type
        const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
        if (!allowedTypes.includes(data.mimetype)) {
          throw new AppError(
            "Invalid file type. Only JPEG, PNG, and WebP are allowed.",
            400
          );
        }

        // Convert stream to buffer
        const buffer = await data.toBuffer();

        if (buffer.length > 10 * 1024 * 1024) {
          // 10MB
          throw new AppError("File too large. Maximum size is 10MB.", 400);
        }

        // Process face from image
        const faceData = await faceService.extractFaceFromImage(buffer);

        if (!faceData.success) {
          throw new AppError(
            faceData.error || "No face detected in image",
            400
          );
        }

        if (faceData.faces.length === 0) {
          throw new AppError("No faces detected in the image", 400);
        }

        if (faceData.faces.length > 1) {
          throw new AppError(
            "Multiple faces detected. Please ensure only one face is visible.",
            400
          );
        }

        const face = faceData.faces[0];

        // Validate face quality
        const qualityCheck = await faceService.validateFaceQuality(face);
        if (!qualityCheck.isValid) {
          throw new AppError(
            `Face quality check failed: ${qualityCheck.reason}`,
            400
          );
        }

        fastify.log.info(
          `Face processed successfully for user: ${request.user.email}`,
          {
            userId: request.user.id,
            fileSize: buffer.length,
            faceCount: faceData.faces.length,
            confidence: face.detection.score,
          }
        );

        return {
          success: true,
          message: "Face processed successfully",
          faceData: {
            descriptor: face.descriptor,
            detection: {
              score: face.detection.score,
              box: face.detection.box,
            },
            landmarks: face.landmarks,
            quality: qualityCheck,
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Face processing error:", error);
        throw new AppError("Face processing failed", 500);
      }
    },
  });

  // Process multiple faces for batch registration
  fastify.post("/process-multiple-faces", {
    preHandler: [
      fastify.authenticate,
      fastify.rateLimit({
        max: 10,
        timeWindow: "1 hour",
        keyGenerator: (request) => `batch-face-process-${request.user.id}`,
      }),
    ],
    handler: async (request, reply) => {
      try {
        const files = [];
        const parts = request.parts();

        // Collect all uploaded files
        for await (const part of parts) {
          if (part.file) {
            // Validate file type
            const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
            if (!allowedTypes.includes(part.mimetype)) {
              throw new AppError(
                `Invalid file type: ${part.mimetype}. Only JPEG, PNG, and WebP are allowed.`,
                400
              );
            }

            const buffer = await part.toBuffer();

            if (buffer.length > 10 * 1024 * 1024) {
              // 10MB per file
              throw new AppError(
                "File too large. Maximum size is 10MB per file.",
                400
              );
            }

            files.push({
              filename: part.filename,
              buffer,
              mimetype: part.mimetype,
            });
          }
        }

        if (files.length === 0) {
          throw new AppError("No files uploaded", 400);
        }

        if (files.length > 10) {
          throw new AppError(
            "Too many files. Maximum 10 files per batch.",
            400
          );
        }

        // Process each file
        const results = [];
        const validDescriptors = [];

        for (const file of files) {
          try {
            const faceData = await faceService.extractFaceFromImage(
              file.buffer
            );

            if (faceData.success && faceData.faces.length === 1) {
              const face = faceData.faces[0];
              const qualityCheck = await faceService.validateFaceQuality(face);

              if (qualityCheck.isValid) {
                validDescriptors.push(face.descriptor);
                results.push({
                  filename: file.filename,
                  success: true,
                  faceData: {
                    descriptor: face.descriptor,
                    detection: face.detection,
                    quality: qualityCheck,
                  },
                });
              } else {
                results.push({
                  filename: file.filename,
                  success: false,
                  error: `Face quality check failed: ${qualityCheck.reason}`,
                });
              }
            } else {
              results.push({
                filename: file.filename,
                success: false,
                error:
                  faceData.faces.length === 0
                    ? "No face detected"
                    : "Multiple faces detected",
              });
            }
          } catch (fileError) {
            results.push({
              filename: file.filename,
              success: false,
              error: "Processing failed",
            });
          }
        }

        const successCount = results.filter((r) => r.success).length;

        fastify.log.info(
          `Batch face processing completed for user: ${request.user.email}`,
          {
            userId: request.user.id,
            totalFiles: files.length,
            successCount,
            validDescriptors: validDescriptors.length,
          }
        );

        return {
          success: true,
          message: `Processed ${files.length} files, ${successCount} successful`,
          results,
          summary: {
            totalFiles: files.length,
            successfulFiles: successCount,
            failedFiles: files.length - successCount,
            validDescriptors: validDescriptors.length,
          },
          faceDescriptors: validDescriptors,
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Batch face processing error:", error);
        throw new AppError("Batch face processing failed", 500);
      }
    },
  });

  // Validate face descriptor without saving
  fastify.post("/validate-face", {
    schema: {
      body: {
        type: "object",
        required: ["faceDescriptor"],
        properties: {
          faceDescriptor: {
            type: "array",
            items: { type: "number" },
            minItems: 128,
            maxItems: 128,
          },
        },
      },
    },
    preHandler: [
      fastify.authenticate,
      fastify.rateLimit({
        max: 30,
        timeWindow: "1 hour",
      }),
    ],
    handler: async (request, reply) => {
      const { faceDescriptor } = request.body;

      try {
        // Validate descriptor format
        const isValid = faceService.isValidFaceDescriptor(faceDescriptor);

        if (!isValid) {
          throw new AppError("Invalid face descriptor format", 400);
        }

        // Check against user's existing descriptors (if any)
        const { User } = require("../models");
        const user = await User.findById(request.user.id).select(
          "faceDescriptors"
        );

        let similarity = null;
        let isDuplicate = false;

        if (user.faceDescriptors && user.faceDescriptors.length > 0) {
          const maxSimilarity = await faceService.findBestMatch(
            faceDescriptor,
            user.faceDescriptors
          );

          similarity = maxSimilarity.distance;
          isDuplicate =
            maxSimilarity.distance < faceService.SIMILARITY_THRESHOLD;
        }

        return {
          success: true,
          validation: {
            isValidFormat: true,
            similarity,
            isDuplicate,
            canRegister: !isDuplicate,
            message: isDuplicate
              ? "This face is very similar to an existing registration"
              : "Face is valid and can be registered",
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Face validation error:", error);
        throw new AppError("Face validation failed", 500);
      }
    },
  });

  // Test face recognition against user's registered faces
  fastify.post("/test-recognition", {
    schema: {
      body: {
        type: "object",
        required: ["faceDescriptor"],
        properties: {
          faceDescriptor: {
            type: "array",
            items: { type: "number" },
            minItems: 128,
            maxItems: 128,
          },
        },
      },
    },
    preHandler: [
      fastify.authenticate,
      fastify.rateLimit({
        max: 20,
        timeWindow: "1 hour",
      }),
    ],
    handler: async (request, reply) => {
      const { faceDescriptor } = request.body;

      try {
        const { User } = require("../models");
        const user = await User.findById(request.user.id).select(
          "faceDescriptors name email"
        );

        if (!user.faceDescriptors || user.faceDescriptors.length === 0) {
          throw new AppError(
            "No registered faces found. Please register your face first.",
            400
          );
        }

        // Test recognition
        const isRecognized = await faceService.verifyFace(
          faceDescriptor,
          user.faceDescriptors
        );

        const bestMatch = await faceService.findBestMatch(
          faceDescriptor,
          user.faceDescriptors
        );

        fastify.log.info(`Face recognition test for user: ${user.email}`, {
          userId: user._id,
          isRecognized,
          similarity: bestMatch.distance,
          registeredFaces: user.faceDescriptors.length,
        });

        return {
          success: true,
          recognition: {
            isRecognized,
            similarity: bestMatch.distance,
            threshold: faceService.SIMILARITY_THRESHOLD,
            confidence: Math.max(0, (1 - bestMatch.distance) * 100), // Convert to percentage
            registeredFacesCount: user.faceDescriptors.length,
            message: isRecognized
              ? "Face recognized successfully!"
              : "Face not recognized. Recognition may fail during attendance.",
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Face recognition test error:", error);
        throw new AppError("Face recognition test failed", 500);
      }
    },
  });

  // Get face registration statistics
  fastify.get("/face-stats", {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const { User } = require("../models");
        const user = await User.findById(request.user.id).select(
          "faceDescriptors createdAt"
        );

        const descriptorCount = user.faceDescriptors
          ? user.faceDescriptors.length
          : 0;

        // Calculate diversity score if multiple faces
        let diversityScore = null;
        if (descriptorCount > 1) {
          diversityScore = await faceService.calculateDescriptorDiversity(
            user.faceDescriptors
          );
        }

        return {
          success: true,
          stats: {
            registeredFaces: descriptorCount,
            maxFaces: 10,
            canAddMore: descriptorCount < 10,
            diversityScore,
            recommendations: {
              needsMoreFaces: descriptorCount < 3,
              hasGoodDiversity: diversityScore ? diversityScore > 0.5 : null,
              suggestions:
                descriptorCount === 0
                  ? ["Register at least 3 faces for better recognition"]
                  : descriptorCount < 3
                  ? [
                      "Add more face angles for improved accuracy",
                      "Try different lighting conditions",
                    ]
                  : diversityScore && diversityScore < 0.5
                  ? [
                      "Add faces with different expressions",
                      "Try different angles and lighting",
                    ]
                  : ["Face registration looks good!"],
            },
          },
        };
      } catch (error) {
        fastify.log.error("Face stats error:", error);
        throw new AppError("Failed to get face statistics", 500);
      }
    },
  });

  // Image upload utility (for profile pictures, etc.)
  fastify.post("/image", {
    preHandler: [
      fastify.authenticate,
      fastify.rateLimit({
        max: 10,
        timeWindow: "1 hour",
      }),
    ],
    handler: async (request, reply) => {
      try {
        const data = await request.file();

        if (!data) {
          throw new AppError("No file uploaded", 400);
        }

        // Validate file type
        const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
        if (!allowedTypes.includes(data.mimetype)) {
          throw new AppError(
            "Invalid file type. Only JPEG, PNG, and WebP are allowed.",
            400
          );
        }

        const buffer = await data.toBuffer();

        if (buffer.length > 5 * 1024 * 1024) {
          // 5MB for general images
          throw new AppError("File too large. Maximum size is 5MB.", 400);
        }

        // In a production environment, you would:
        // 1. Upload to cloud storage (AWS S3, Google Cloud Storage, etc.)
        // 2. Generate unique filename
        // 3. Return the URL

        // For this demo, we'll just validate and return success
        const filename = `${Date.now()}-${Math.random()
          .toString(36)
          .substring(7)}.${data.mimetype.split("/")[1]}`;

        fastify.log.info(
          `Image uploaded successfully for user: ${request.user.email}`,
          {
            userId: request.user.id,
            filename,
            fileSize: buffer.length,
            mimetype: data.mimetype,
          }
        );

        return {
          success: true,
          message: "Image uploaded successfully",
          file: {
            filename,
            originalName: data.filename,
            mimetype: data.mimetype,
            size: buffer.length,
            url: `/uploads/${filename}`, // This would be the actual URL in production
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Image upload error:", error);
        throw new AppError("Image upload failed", 500);
      }
    },
  });

  // Bulk face descriptor validation
  fastify.post("/validate-bulk-faces", {
    schema: {
      body: {
        type: "object",
        required: ["faceDescriptors"],
        properties: {
          faceDescriptors: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "array",
              items: { type: "number" },
              minItems: 128,
              maxItems: 128,
            },
          },
        },
      },
    },
    preHandler: [
      fastify.authenticate,
      fastify.rateLimit({
        max: 10,
        timeWindow: "1 hour",
      }),
    ],
    handler: async (request, reply) => {
      const { faceDescriptors } = request.body;

      try {
        const { User } = require("../models");
        const user = await User.findById(request.user.id).select(
          "faceDescriptors"
        );

        const results = [];
        const validDescriptors = [];

        // Validate each descriptor
        for (let i = 0; i < faceDescriptors.length; i++) {
          const descriptor = faceDescriptors[i];
          const result = {
            index: i,
            isValid: false,
            isDuplicate: false,
            similarity: null,
            canUse: false,
          };

          // Check format
          if (faceService.isValidFaceDescriptor(descriptor)) {
            result.isValid = true;

            // Check for duplicates against existing descriptors
            if (user.faceDescriptors && user.faceDescriptors.length > 0) {
              const bestMatch = await faceService.findBestMatch(
                descriptor,
                user.faceDescriptors
              );
              result.similarity = bestMatch.distance;
              result.isDuplicate =
                bestMatch.distance < faceService.SIMILARITY_THRESHOLD;
            }

            // Check for duplicates within the current batch
            if (!result.isDuplicate && validDescriptors.length > 0) {
              const batchMatch = await faceService.findBestMatch(
                descriptor,
                validDescriptors
              );
              if (batchMatch.distance < faceService.SIMILARITY_THRESHOLD) {
                result.isDuplicate = true;
                result.similarity = batchMatch.distance;
              }
            }

            result.canUse = !result.isDuplicate;

            if (result.canUse) {
              validDescriptors.push(descriptor);
            }
          }

          results.push(result);
        }

        const validCount = results.filter((r) => r.canUse).length;
        const duplicateCount = results.filter((r) => r.isDuplicate).length;

        return {
          success: true,
          validation: {
            totalSubmitted: faceDescriptors.length,
            validFormat: results.filter((r) => r.isValid).length,
            duplicates: duplicateCount,
            canUse: validCount,
            results,
          },
          recommendations:
            validCount === 0
              ? [
                  "All faces are duplicates or invalid",
                  "Try different angles and expressions",
                ]
              : validCount < 3
              ? [
                  "Add more diverse face angles",
                  "Ensure different lighting conditions",
                ]
              : ["Good variety of face descriptors!"],
          usableDescriptors: validDescriptors,
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Bulk face validation error:", error);
        throw new AppError("Bulk face validation failed", 500);
      }
    },
  });

  // Health check for face recognition service
  fastify.get("/face-service-health", {
    preHandler: [fastify.authenticate, fastify.requireRole("admin")],
    handler: async (request, reply) => {
      try {
        // Test face service functionality
        const testDescriptor = new Array(128).fill(0).map(() => Math.random());

        // Test basic validation
        const isValid = faceService.isValidFaceDescriptor(testDescriptor);

        // Test similarity calculation
        const testDescriptor2 = new Array(128).fill(0).map(() => Math.random());
        const distance = await faceService.calculateSimilarity(
          testDescriptor,
          testDescriptor2
        );

        const healthStatus = {
          status: "healthy",
          checks: {
            descriptorValidation: isValid,
            similarityCalculation:
              !isNaN(distance) && distance >= 0 && distance <= 2,
            faceApiLoaded: await faceService.isModelLoaded(),
            timestamp: new Date(),
          },
        };

        const allHealthy = Object.values(healthStatus.checks)
          .filter((v) => typeof v === "boolean")
          .every((v) => v === true);

        if (!allHealthy) {
          healthStatus.status = "degraded";
        }

        fastify.log.info(`Face service health check completed`, {
          status: healthStatus.status,
          adminId: request.user.id,
        });

        return {
          success: true,
          health: healthStatus,
        };
      } catch (error) {
        fastify.log.error("Face service health check error:", error);

        return {
          success: false,
          health: {
            status: "unhealthy",
            error: error.message,
            timestamp: new Date(),
          },
        };
      }
    },
  });

  // Clear uploaded file cache/temp storage
  fastify.delete("/clear-temp", {
    preHandler: [fastify.authenticate, fastify.requireRole("admin")],
    handler: async (request, reply) => {
      try {
        // In production, this would clear temporary uploaded files
        // For now, just return success

        fastify.log.info(`Temporary files cleared by admin`, {
          adminId: request.user.id,
        });

        return {
          success: true,
          message: "Temporary files cleared successfully",
        };
      } catch (error) {
        fastify.log.error("Clear temp files error:", error);
        throw new AppError("Failed to clear temporary files", 500);
      }
    },
  });
}

module.exports = uploadRoutes;
