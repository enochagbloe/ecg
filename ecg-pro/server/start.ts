// Cross-platform production startup, including Windows.
process.env = { ...process.env, NODE_ENV: "production" };
void import("./index");