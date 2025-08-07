// backend/src/models/User.ts
import { Schema, model, Document } from "mongoose";

export interface IUser extends Document {
  _id: string;
  name: string;
  email: string;
  faceDescriptor: number[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: [2, "Name must be at least 2 characters long"],
      maxlength: [50, "Name cannot exceed 50 characters"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      trim: true,
      lowercase: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
        "Please provide a valid email",
      ],
    },
    faceDescriptor: {
      type: [Number],
      required: [true, "Face descriptor is required"],
      validate: {
        validator: function (v: number[]) {
          return v && v.length === 128; // face-api.js returns 128-dimensional vectors
        },
        message: "Face descriptor must be a 128-dimensional array",
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Indexes for better query performance
UserSchema.index({ email: 1 });
UserSchema.index({ isActive: 1 });
UserSchema.index({ createdAt: -1 });

// Instance methods
UserSchema.methods.toSafeObject = function () {
  const userObject = this.toObject();
  delete userObject.faceDescriptor; // Don't expose face data in API responses
  return userObject;
};

export const User = model<IUser>("User", UserSchema);
