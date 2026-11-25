import mongoose from "mongoose";
import { ROLES } from "../identityConstants.js";

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            minlength: 2,
            maxlength: 100
        },

        email: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
            maxlength: 254,
            match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        },

        passwordHash: {
            type: String,
            required: true,
            select: false
        },

        role: {
            type: String,
            enum: Object.values(ROLES),
            required: true,
            immutable: true
        },

        isActive: {
            type: Boolean,
            default: true,
            required: true
        }
    },
    {
        timestamps: true,
        collection: "users",
        versionKey: false,
        toJSON: {
            virtuals: true,
            transform(doc, ret) {
                delete ret.passwordHash;
                delete ret.__v;
                return ret;
            }
        }
    }
);

userSchema.index(
    { email: 1 },
    { unique: true }
);

export default mongoose.model("User", userSchema);