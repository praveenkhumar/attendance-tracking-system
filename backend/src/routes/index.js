// backend/src/routes/index.js
const authRoutes = require("./auth");
const userRoutes = require("./users");
const attendanceRoutes = require("./attendance");
const uploadRoutes = require("./upload");

/**
 * Register all API routes
 */
async function routes(fastify, options) {
  // Health check route (no authentication required)
  fastify.get("/health", {
    schema: {
      response: {
        200: {
          type: "object",
          properties: {
            status: { type: "string" },
            timestamp: { type: "string" },
            uptime: { type: "number" },
            version: { type: "string" },
            services: {
              type: "object",
              properties: {
                database: { type: "string" },
                redis: { type: "string" },
                faceRecognition: { type: "string" },
              },
            },
          },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        // Check database connection
        const { mongoose } = require("mongoose");
        const dbStatus =
          mongoose.connection.readyState === 1 ? "connected" : "disconnected";

        // Check Redis connection
        const { cacheService } = require("../services");
        let redisStatus = "disconnected";
        try {
          await cacheService.ping();
          redisStatus = "connected";
        } catch (error) {
          fastify.log.warn("Redis health check failed:", error.message);
        }

        // Check face recognition service
        const { faceService } = require("../services");
        let faceServiceStatus = "unavailable";
        try {
          const isLoaded = await faceService.isModelLoaded();
          faceServiceStatus = isLoaded ? "ready" : "loading";
        } catch (error) {
          fastify.log.warn("Face service health check failed:", error.message);
        }

        const health = {
          status: "healthy",
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          version: process.env.npm_package_version || "1.0.0",
          services: {
            database: dbStatus,
            redis: redisStatus,
            faceRecognition: faceServiceStatus,
          },
        };

        // Determine overall health status
        const criticalServices = [dbStatus, redisStatus];
        const hasUnhealthyService = criticalServices.some(
          (status) => status !== "connected"
        );

        if (hasUnhealthyService) {
          health.status = "degraded";
          reply.code(503); // Service Unavailable
        }

        return health;
      } catch (error) {
        fastify.log.error("Health check error:", error);

        reply.code(503);
        return {
          status: "unhealthy",
          timestamp: new Date().toISOString(),
          error: error.message,
        };
      }
    },
  });

  // API Info route
  fastify.get("/info", {
    handler: async (request, reply) => {
      return {
        name: "Face Recognition Attendance API",
        version: process.env.npm_package_version || "1.0.0",
        description: "REST API for face recognition based attendance system",
        documentation: "/api/docs", // If you add swagger documentation
        endpoints: {
          auth: "/api/auth/*",
          users: "/api/users/*",
          attendance: "/api/attendance/*",
          upload: "/api/upload/*",
        },
        features: [
          "Face recognition authentication",
          "Attendance tracking",
          "User management",
          "File upload processing",
          "Real-time status monitoring",
          "Admin reporting",
        ],
        contact: {
          email: "support@attendance.com",
        },
      };
    },
  });

  // Register route groups with prefixes
  await fastify.register(authRoutes, { prefix: "/auth" });
  await fastify.register(userRoutes, { prefix: "/users" });
  await fastify.register(attendanceRoutes, { prefix: "/attendance" });
  await fastify.register(uploadRoutes, { prefix: "/upload" });

  // Catch-all route for undefined endpoints
  fastify.setNotFoundHandler(
    {
      preHandler: fastify.rateLimit({
        max: 10,
        timeWindow: "1 minute",
      }),
    },
    (request, reply) => {
      reply.code(404).send({
        error: "Not Found",
        message: `Route ${request.method} ${request.url} not found`,
        availableEndpoints: {
          health: "GET /api/health",
          info: "GET /api/info",
          auth: "POST /api/auth/login, POST /api/auth/register, POST /api/auth/logout",
          users:
            "GET /api/users/profile, PUT /api/users/profile, POST /api/users/register-face",
          attendance:
            "POST /api/attendance/checkin, POST /api/attendance/checkout, GET /api/attendance/status",
          upload: "POST /api/upload/process-face, POST /api/upload/image",
        },
      });
    }
  );
}

module.exports = routes;
