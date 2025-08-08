// backend/src/utils/validation.js
/**
 * Validation utility functions
 */

function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function validatePassword(password) {
  return password && password.length >= 6;
}

function validateEmployeeId(employeeId) {
  if (!employeeId) return true; // Optional field
  return employeeId.length >= 2 && employeeId.length <= 20;
}

function validateName(name) {
  return name && name.trim().length >= 2 && name.trim().length <= 50;
}

function validateDepartment(department) {
  if (!department) return true; // Optional field
  return department.trim().length <= 50;
}

function sanitizeInput(input) {
  if (typeof input !== "string") return input;

  return input
    .trim()
    .replace(/[<>]/g, "") // Remove potential HTML tags
    .slice(0, 1000); // Limit length
}

function validatePagination(page, limit) {
  const pageNum = parseInt(page) || 1;
  const limitNum = parseInt(limit) || 20;

  return {
    page: Math.max(1, pageNum),
    limit: Math.min(100, Math.max(1, limitNum)),
  };
}

function validateDateRange(startDate, endDate) {
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;

  const errors = [];

  if (start && isNaN(start.getTime())) {
    errors.push("Invalid start date format");
  }

  if (end && isNaN(end.getTime())) {
    errors.push("Invalid end date format");
  }

  if (start && end && start > end) {
    errors.push("Start date cannot be after end date");
  }

  return {
    isValid: errors.length === 0,
    errors,
    startDate: start,
    endDate: end,
  };
}

module.exports = {
  validateEmail,
  validatePassword,
  validateEmployeeId,
  validateName,
  validateDepartment,
  sanitizeInput,
  validatePagination,
  validateDateRange,
};

// backend/src/utils/constants.js
/**
 * Application constants
 */

const ATTENDANCE_STATUS = {
  NOT_CHECKED_IN: "not_checked_in",
  CHECKED_IN: "checked_in",
  CHECKED_OUT: "checked_out",
};

const USER_ROLES = {
  ADMIN: "admin",
  EMPLOYEE: "employee",
};

const FACE_RECOGNITION = {
  SIMILARITY_THRESHOLD: 0.6,
  MIN_FACE_SIZE: 160,
  MAX_DESCRIPTORS_PER_USER: 10,
  SUPPORTED_IMAGE_TYPES: ["image/jpeg", "image/png", "image/webp"],
  MAX_IMAGE_SIZE: 10 * 1024 * 1024, // 10MB
};

const RATE_LIMITS = {
  AUTH_LOGIN: { max: 5, window: "15 minutes" },
  AUTH_REGISTER: { max: 3, window: "1 hour" },
  FACE_PROCESS: { max: 20, window: "1 hour" },
  ATTENDANCE: { max: 10, window: "1 minute" },
  PASSWORD_RESET: { max: 3, window: "1 hour" },
};

const CACHE_KEYS = {
  USER_SESSION: (sessionId) => `session:${sessionId}`,
  TODAYS_ATTENDANCE: (userId) => `attendance:today:${userId}`,
  FACE_MODEL_STATUS: "face:model:loaded",
  USER_STATS: (userId) => `stats:user:${userId}`,
  DAILY_STATS: (date) => `stats:daily:${date}`,
};

const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  AUTHENTICATION_ERROR: "AUTHENTICATION_ERROR",
  AUTHORIZATION_ERROR: "AUTHORIZATION_ERROR",
  NOT_FOUND_ERROR: "NOT_FOUND_ERROR",
  FACE_RECOGNITION_ERROR: "FACE_RECOGNITION_ERROR",
  DATABASE_ERROR: "DATABASE_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
};

const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

module.exports = {
  ATTENDANCE_STATUS,
  USER_ROLES,
  FACE_RECOGNITION,
  RATE_LIMITS,
  CACHE_KEYS,
  ERROR_CODES,
  HTTP_STATUS,
};

// backend/src/utils/helpers.js
/**
 * General helper functions
 */

const crypto = require("crypto");

/**
 * Generate a secure random string
 */
function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString("hex");
}

/**
 * Hash a string using SHA-256
 */
function hashString(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Format duration from seconds to human readable format
 */
function formatDuration(seconds) {
  if (!seconds || seconds < 0) return "0m";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (remainingSeconds > 0 || parts.length === 0) {
    parts.push(`${Math.floor(remainingSeconds)}s`);
  }

  return parts.join(" ");
}

/**
 * Format date to YYYY-MM-DD
 */
function formatDate(date) {
  return new Date(date).toISOString().split("T")[0];
}

/**
 * Get start and end of day for a given date
 */
function getDayBounds(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

/**
 * Get start and end of week
 */
function getWeekBounds(date = new Date()) {
  const start = new Date(date);
  const day = start.getDay();
  const diff = start.getDate() - day;
  start.setDate(diff);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

/**
 * Get start and end of month
 */
function getMonthBounds(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  start.setHours(0, 0, 0, 0);

  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

/**
 * Calculate age from date of birth
 */
function calculateAge(dateOfBirth) {
  const today = new Date();
  const birth = new Date(dateOfBirth);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }

  return age;
}

/**
 * Deep clone an object
 */
function deepClone(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (obj instanceof Date) return new Date(obj.getTime());
  if (obj instanceof Array) return obj.map((item) => deepClone(item));
  if (typeof obj === "object") {
    const cloned = {};
    for (let key in obj) {
      if (obj.hasOwnProperty(key)) {
        cloned[key] = deepClone(obj[key]);
      }
    }
    return cloned;
  }
}

/**
 * Remove sensitive data from user object
 */
function sanitizeUser(user) {
  if (!user) return null;

  const sanitized = { ...user };
  delete sanitized.password;
  delete sanitized.faceDescriptors;
  delete sanitized.__v;

  return sanitized;
}

/**
 * Generate pagination metadata
 */
function generatePaginationMeta(page, limit, total) {
  const totalPages = Math.ceil(total / limit);

  return {
    currentPage: page,
    totalPages,
    totalItems: total,
    itemsPerPage: limit,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
    nextPage: page < totalPages ? page + 1 : null,
    prevPage: page > 1 ? page - 1 : null,
  };
}

/**
 * Validate MongoDB ObjectId
 */
function isValidObjectId(id) {
  return /^[0-9a-fA-F]{24}$/.test(id);
}

/**
 * Sleep/delay function for async operations
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry async operation with exponential backoff
 */
async function retryOperation(operation, maxRetries = 3, baseDelay = 1000) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        throw lastError;
      }

      const delay = baseDelay * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Create a debounced function
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Create a throttled function
 */
function throttle(func, limit) {
  let inThrottle;
  return function (...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Convert CSV data to objects
 */
function csvToObjects(csvData, headers) {
  const lines = csvData.split("\n");
  const result = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      const values = line.split(",");
      const obj = {};

      headers.forEach((header, index) => {
        obj[header] = values[index] || "";
      });

      result.push(obj);
    }
  }

  return result;
}

/**
 * Convert objects to CSV
 */
function objectsToCSV(objects, headers) {
  if (!objects || objects.length === 0) return "";

  const csvHeaders = headers || Object.keys(objects[0]);
  const csvRows = [csvHeaders.join(",")];

  objects.forEach((obj) => {
    const values = csvHeaders.map((header) => {
      const value = obj[header];
      // Escape commas and quotes in CSV
      if (
        typeof value === "string" &&
        (value.includes(",") || value.includes('"'))
      ) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value || "";
    });
    csvRows.push(values.join(","));
  });

  return csvRows.join("\n");
}

module.exports = {
  generateSecureToken,
  hashString,
  formatDuration,
  formatDate,
  getDayBounds,
  getWeekBounds,
  getMonthBounds,
  calculateAge,
  deepClone,
  sanitizeUser,
  generatePaginationMeta,
  isValidObjectId,
  sleep,
  retryOperation,
  debounce,
  throttle,
  csvToObjects,
  objectsToCSV,
};
