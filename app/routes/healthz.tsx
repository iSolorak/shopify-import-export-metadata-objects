import db from "../db.server";

// Unauthenticated liveness/readiness probe for nginx, Docker and uptime checks.
// Touches the database so a broken volume mount surfaces as a failing check
// rather than a healthy container serving 500s.
export const loader = async () => {
  try {
    await db.$queryRaw`SELECT 1`;
  } catch (error) {
    console.error("Health check failed", error);
    return Response.json({ status: "error", database: "down" }, { status: 503 });
  }

  return Response.json({ status: "ok" });
};
