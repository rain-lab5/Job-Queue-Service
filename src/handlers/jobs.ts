import type { Request, Response } from "express";
import type { JobService } from "../services/jobService.js";
import { ValidationError } from "../domain/jobs.js";
import { validateAck, validateClaim, validateEnqueue, validateId, validateIdempotencyKey } from "../validation/jobs.js";

export function createJobHandlers(service: JobService) {
    return {
        async enqueue(req: Request, res: Response) {
            const keys = req.rawHeaders.filter((_, index) => index % 2 === 0)
                .filter(name => name.toLowerCase() === "idempotency-key");
            if (keys.length > 1) throw new ValidationError("Only one Idempotency-Key header is allowed");
            const input = validateEnqueue(req.body);
            const key = validateIdempotencyKey(req.get("Idempotency-Key"));
            res.status(201).json(await service.enqueue(input, key));
        },
        async claim(req: Request, res: Response) {
            res.status(200).json(await service.claim(validateClaim(req.body)));
        },
        async acknowledge(req: Request, res: Response) {
            const id = validateId(String(req.params.id));
            res.status(200).json(await service.acknowledge(id, validateAck(req.body)));
        },
    };
}
