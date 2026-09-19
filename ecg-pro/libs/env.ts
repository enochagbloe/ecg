import dotenv from "dotenv";

// Environment variables supplied by the deployment take precedence.
dotenv.config({ path: [".env.local", ".env"], quiet: true });