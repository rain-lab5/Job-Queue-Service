import { type Request,type Response } from "express";
import {db} from '../db/index.js';
import { sql } from "drizzle-orm";
import { timeout } from "../utils/timeout.js";

const HEALTH_CHECK_TIMEOUT_MS = 500;


export async function handleHealth(req : Request, res : Response)
{
    try
    {
        await Promise.race([
            db.execute(sql`SELECT 1`),
            timeout(HEALTH_CHECK_TIMEOUT_MS)
        ]);
        
        res.status(200).json({
            "status":"ok",
            "database":"ok"
        });

    }
    catch(e)
    {
        console.error(e);
        res.status(503).json({
            "status":"degraded",
            "database" : "unavailable"
        });
    }
}