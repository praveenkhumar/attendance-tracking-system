// backend/src/routes/users.js
const { User } = require("../models");
const { faceService } = require("../services");
const { AppError } = require("../utils/errors");
const { validatePassword } = require("../utils/validation");

/**
 * User Management Routes Plugin
 */
async function userRoutes(fastify, options) {
  // Get current user profile
  fastify.get("/profile", {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const user = await User.findById(request.user.id).select(
          "-password -faceDescriptors -__v"
        );

        if (!user) {
          throw new AppError("User not found", 404);
        }

        return {
          success: true,
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            department: user.department,
            employeeId: user.employeeId,
            role: user.role,
            isActive: user.isActive,
            hasFaceRegistered:
              user.faceDescriptors && user.faceDescriptors.length > 0,
            createdAt: user.createdAt,
            lastLogin: user.lastLogin,
            stats: {
              totalFaceDescriptors: user.faceDescriptors
                ? user.faceDescriptors.length
                : 0,
            },
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Get profile error:", error);
        throw new AppError("Failed to fetch profile", 500);
      }
    },
  });

  // Update user profile
  fastify.put("/profile", {
    schema: {
      body: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 2, maxLength: 50 },
          department: { type: "string", maxLength: 50 },
          employeeId: { type: "string", maxLength: 20 },
        },
      },
    },
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const { name, department, employeeId } = request.body;

      try {
        const user = await User.findById(request.user.id);

        if (!user) {
          throw new AppError("User not found", 404);
        }

        // Check if employeeId is being changed and if it already exists
        if (employeeId && employeeId !== user.employeeId) {
          const existingUser = await User.findOne({
            employeeId,
            _id: { $ne: user._id },
          });

          if (existingUser) {
            throw new AppError("Employee ID already exists", 409);
          }
        }

        // Update fields
        if (name) user.name = name.trim();
        if (department !== undefined) user.department = department?.trim();
        if (employeeId !== undefined) user.employeeId = employeeId?.trim();

        user.updatedAt = new Date();
        await user.save();

        fastify.log.info(`Profile updated for user: ${user.email}`, {
          userId: user._id,
          changes: {
            name: !!name,
            department: department !== undefined,
            employeeId: employeeId !== undefined,
          },
        });

        return {
          success: true,
          message: "Profile updated successfully",
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            department: user.department,
            employeeId: user.employeeId,
            role: user.role,
            updatedAt: user.updatedAt,
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        if (error.code === 11000) {
          throw new AppError("Employee ID already exists", 409);
        }

        fastify.log.error("Update profile error:", error);
        throw new AppError("Failed to update profile", 500);
      }
    },
  });

  // Register face descriptors
  fastify.post("/register-face", {
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
          replaceExisting: { type: "boolean", default: false },
        },
      },
    },
    preHandler: [
      fastify.authenticate,
      fastify.rateLimit({
        max: 5,
        timeWindow: "1 hour",
      }),
    ],
    handler: async (request, reply) => {
      const { faceDescriptors, replaceExisting } = request.body;

      try {
        const user = await User.findById(request.user.id);

        if (!user) {
          throw new AppError("User not found", 404);
        }

        // Validate face descriptors
        const validDescriptors = [];
        for (const descriptor of faceDescriptors) {
          if (faceService.isValidFaceDescriptor(descriptor)) {
            validDescriptors.push(descriptor);
          }
        }

        if (validDescriptors.length === 0) {
          throw new AppError("No valid face descriptors provided", 400);
        }

        // Check for duplicates within the new descriptors
        const uniqueDescriptors =
          faceService.removeDuplicateDescriptors(validDescriptors);

        // Handle existing descriptors
        let finalDescriptors;
        if (replaceExisting) {
          finalDescriptors = uniqueDescriptors;
        } else {
          // Merge with existing descriptors and remove duplicates
          const allDescriptors = [
            ...(user.faceDescriptors || []),
            ...uniqueDescriptors,
          ];
          finalDescriptors =
            faceService.removeDuplicateDescriptors(allDescriptors);
        }

        // Limit total descriptors (max 10 per user)
        if (finalDescriptors.length > 10) {
          finalDescriptors = finalDescriptors.slice(0, 10);
        }

        // Update user
        user.faceDescriptors = finalDescriptors;
        user.updatedAt = new Date();
        await user.save();

        fastify.log.info(
          `Face descriptors registered for user: ${user.email}`,
          {
            userId: user._id,
            descriptorsCount: finalDescriptors.length,
            newDescriptors: uniqueDescriptors.length,
            replaced: replaceExisting,
          }
        );

        return {
          success: true,
          message: "Face registration successful",
          stats: {
            totalDescriptors: finalDescriptors.length,
            newDescriptorsAdded: uniqueDescriptors.length,
            replaced: replaceExisting,
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Face registration error:", error);
        throw new AppError("Face registration failed", 500);
      }
    },
  });

  // Change password
  fastify.put("/change-password", {
    schema: {
      body: {
        type: "object",
        required: ["currentPassword", "newPassword"],
        properties: {
          currentPassword: { type: "string" },
          newPassword: { type: "string", minLength: 6 },
        },
      },
    },
    preHandler: [
      fastify.authenticate,
      fastify.rateLimit({
        max: 5,
        timeWindow: "15 minutes",
      }),
    ],
    handler: async (request, reply) => {
      const { currentPassword, newPassword } = request.body;

      try {
        if (!validatePassword(newPassword)) {
          throw new AppError(
            "New password must be at least 6 characters long",
            400
          );
        }

        const user = await User.findById(request.user.id).select("+password");

        if (!user) {
          throw new AppError("User not found", 404);
        }

        // Verify current password
        const isCurrentPasswordValid = await user.comparePassword(
          currentPassword
        );
        if (!isCurrentPasswordValid) {
          throw new AppError("Current password is incorrect", 401);
        }

        // Update password
        user.password = newPassword; // Will be hashed by pre-save middleware
        user.updatedAt = new Date();
        await user.save();

        fastify.log.info(`Password changed for user: ${user.email}`, {
          userId: user._id,
          ip: request.ip,
        });

        return {
          success: true,
          message: "Password changed successfully",
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Change password error:", error);
        throw new AppError("Failed to change password", 500);
      }
    },
  });

  // Get face registration status
  fastify.get("/face-status", {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const user = await User.findById(request.user.id).select(
          "faceDescriptors name email"
        );

        if (!user) {
          throw new AppError("User not found", 404);
        }

        const descriptorCount = user.faceDescriptors
          ? user.faceDescriptors.length
          : 0;

        return {
          success: true,
          faceStatus: {
            isRegistered: descriptorCount > 0,
            descriptorCount,
            maxDescriptors: 10,
            canAddMore: descriptorCount < 10,
            user: {
              name: user.name,
              email: user.email,
            },
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Get face status error:", error);
        throw new AppError("Failed to get face status", 500);
      }
    },
  });

  // Clear face descriptors
  fastify.delete("/clear-face", {
    preHandler: [
      fastify.authenticate,
      fastify.rateLimit({
        max: 3,
        timeWindow: "1 hour",
      }),
    ],
    handler: async (request, reply) => {
      try {
        const user = await User.findById(request.user.id);

        if (!user) {
          throw new AppError("User not found", 404);
        }

        const previousCount = user.faceDescriptors
          ? user.faceDescriptors.length
          : 0;

        user.faceDescriptors = [];
        user.updatedAt = new Date();
        await user.save();

        fastify.log.info(`Face descriptors cleared for user: ${user.email}`, {
          userId: user._id,
          previousCount,
        });

        return {
          success: true,
          message: "Face descriptors cleared successfully",
          stats: {
            previousCount,
            currentCount: 0,
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Clear face descriptors error:", error);
        throw new AppError("Failed to clear face descriptors", 500);
      }
    },
  });

  // Admin: Get all users (admin only)
  fastify.get("/all", {
    preHandler: [fastify.authenticate, fastify.requireRole("admin")],
    schema: {
      querystring: {
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1, default: 1 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          search: { type: "string", maxLength: 50 },
          department: { type: "string", maxLength: 50 },
          role: { type: "string", enum: ["employee", "admin"] },
          isActive: { type: "boolean" },
        },
      },
    },
    handler: async (request, reply) => {
      const { page, limit, search, department, role, isActive } = request.query;

      try {
        // Build query
        const query = {};

        if (search) {
          query.$or = [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
            { employeeId: { $regex: search, $options: "i" } },
          ];
        }

        if (department)
          query.department = { $regex: department, $options: "i" };
        if (role) query.role = role;
        if (isActive !== undefined) query.isActive = isActive;

        // Execute query with pagination
        const skip = (page - 1) * limit;
        const [users, total] = await Promise.all([
          User.find(query)
            .select("-password -faceDescriptors -__v")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
          User.countDocuments(query),
        ]);

        const totalPages = Math.ceil(total / limit);

        return {
          success: true,
          users: users.map((user) => ({
            ...user.toObject(),
            hasFaceRegistered:
              user.faceDescriptors && user.faceDescriptors.length > 0,
          })),
          pagination: {
            page,
            limit,
            total,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1,
          },
        };
      } catch (error) {
        fastify.log.error("Get all users error:", error);
        throw new AppError("Failed to fetch users", 500);
      }
    },
  });

  // Admin: Update user status (admin only)
  fastify.put("/:userId/status", {
    schema: {
      params: {
        type: "object",
        required: ["userId"],
        properties: {
          userId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        },
      },
      body: {
        type: "object",
        properties: {
          isActive: { type: "boolean" },
          role: { type: "string", enum: ["employee", "admin"] },
        },
      },
    },
    preHandler: [fastify.authenticate, fastify.requireRole("admin")],
    handler: async (request, reply) => {
      const { userId } = request.params;
      const { isActive, role } = request.body;

      try {
        const user = await User.findById(userId);

        if (!user) {
          throw new AppError("User not found", 404);
        }

        // Prevent admin from deactivating themselves
        if (userId === request.user.id && isActive === false) {
          throw new AppError("Cannot deactivate your own account", 400);
        }

        // Update fields
        if (isActive !== undefined) user.isActive = isActive;
        if (role !== undefined) user.role = role;

        user.updatedAt = new Date();
        await user.save();

        fastify.log.info(`User status updated by admin: ${user.email}`, {
          adminId: request.user.id,
          userId: user._id,
          changes: { isActive, role },
        });

        return {
          success: true,
          message: "User status updated successfully",
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            isActive: user.isActive,
            role: user.role,
            updatedAt: user.updatedAt,
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Update user status error:", error);
        throw new AppError("Failed to update user status", 500);
      }
    },
  });
}

module.exports = userRoutes;
