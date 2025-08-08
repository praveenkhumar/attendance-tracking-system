import { FastifyRequest, FastifyReply } from "fastify";
import Joi from "joi";
import { logger } from "../utils/logger";

export class ValidationMiddleware {
  static validate(schema: Joi.ObjectSchema) {
    return async (
      request: FastifyRequest,
      reply: FastifyReply
    ): Promise<void> => {
      try {
        const { error, value } = schema.validate(request.body);

        if (error) {
          const errorMessages = error.details.map((detail) => detail.message);
          reply.code(400).send({
            success: false,
            message: "Validation error",
            errors: errorMessages,
          });
          return;
        }

        // Replace request body with validated and sanitized data
        request.body = value;
      } catch (validationError) {
        logger.error("Validation middleware error:", validationError);
        reply.code(500).send({
          success: false,
          message: "Internal server error",
        });
      }
    };
  }

  static validateQuery(schema: Joi.ObjectSchema) {
    return async (
      request: FastifyRequest,
      reply: FastifyReply
    ): Promise<void> => {
      try {
        const { error, value } = schema.validate(request.query);

        if (error) {
          const errorMessages = error.details.map((detail) => detail.message);
          reply.code(400).send({
            success: false,
            message: "Query validation error",
            errors: errorMessages,
          });
          return;
        }

        // Replace request query with validated data
        request.query = value;
      } catch (validationError) {
        logger.error("Query validation middleware error:", validationError);
        reply.code(500).send({
          success: false,
          message: "Internal server error",
        });
      }
    };
  }

  static validateParams(schema: Joi.ObjectSchema) {
    return async (
      request: FastifyRequest,
      reply: FastifyReply
    ): Promise<void> => {
      try {
        const { error, value } = schema.validate(request.params);

        if (error) {
          const errorMessages = error.details.map((detail) => detail.message);
          reply.code(400).send({
            success: false,
            message: "Parameter validation error",
            errors: errorMessages,
          });
          return;
        }

        // Replace request params with validated data
        request.params = value;
      } catch (validationError) {
        logger.error("Parameter validation middleware error:", validationError);
        reply.code(500).send({
          success: false,
          message: "Internal server error",
        });
      }
    };
  }
}

// Common validation schemas
export const ValidationSchemas = {
  // Authentication schemas
  login: Joi.object({
    email: Joi.string().email().required().messages({
      "string.email": "Please provide a valid email address",
      "any.required": "Email is required",
    }),
    password: Joi.string().min(6).required().messages({
      "string.min": "Password must be at least 6 characters long",
      "any.required": "Password is required",
    }),
  }),

  register: Joi.object({
    name: Joi.string().min(2).max(100).required().messages({
      "string.min": "Name must be at least 2 characters long",
      "string.max": "Name cannot exceed 100 characters",
      "any.required": "Name is required",
    }),
    email: Joi.string().email().required().messages({
      "string.email": "Please provide a valid email address",
      "any.required": "Email is required",
    }),
    password: Joi.string().min(6).max(128).required().messages({
      "string.min": "Password must be at least 6 characters long",
      "string.max": "Password cannot exceed 128 characters",
      "any.required": "Password is required",
    }),
  }),

  changePassword: Joi.object({
    oldPassword: Joi.string().required().messages({
      "any.required": "Current password is required",
    }),
    newPassword: Joi.string().min(6).max(128).required().messages({
      "string.min": "New password must be at least 6 characters long",
      "string.max": "New password cannot exceed 128 characters",
      "any.required": "New password is required",
    }),
  }),

  // User management schemas
  updateUser: Joi.object({
    name: Joi.string().min(2).max(100).optional().messages({
      "string.min": "Name must be at least 2 characters long",
      "string.max": "Name cannot exceed 100 characters",
    }),
    email: Joi.string().email().optional().messages({
      "string.email": "Please provide a valid email address",
    }),
    isActive: Joi.boolean().optional(),
    role: Joi.string().valid("admin", "user").optional(),
  }),

  // Attendance schemas
  attendanceQuery: Joi.object({
    userId: Joi.string().optional(),
    startDate: Joi.date().iso().optional(),
    endDate: Joi.date().iso().min(Joi.ref("startDate")).optional(),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(50),
  }),

  // Parameter schemas
  mongoId: Joi.object({
    id: Joi.string().hex().length(24).required().messages({
      "string.hex": "Invalid ID format",
      "string.length": "ID must be 24 characters long",
      "any.required": "ID is required",
    }),
  }),

  // File upload validation
  imageUpload: Joi.object({
    filename: Joi.string().required(),
    mimetype: Joi.string()
      .valid("image/jpeg", "image/jpg", "image/png", "image/webp")
      .required()
      .messages({
        "any.only": "Only JPEG, JPG, PNG, and WebP images are allowed",
      }),
    size: Joi.number()
      .max(5 * 1024 * 1024)
      .required()
      .messages({
        "number.max": "File size cannot exceed 5MB",
      }),
  }),

  // Stats query
  statsQuery: Joi.object({
    startDate: Joi.date().iso().optional(),
    endDate: Joi.date().iso().min(Joi.ref("startDate")).optional(),
  }),
};
