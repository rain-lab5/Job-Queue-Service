import { type Request, type Response } from "express";
import { checkDatabaseHealth } from "../repositories/healthRepository.js";

export async function handleHealth(_req: Request, res: Response) {
    try {
        await checkDatabaseHealth();
        res.status(200).json({
            status: "ok",
            database: "ok",
        });
    } catch (error) {
        console.error(error);
        res.status(503).json({
            status: "degraded",
            database: "unavailable",
        });
    }
}
