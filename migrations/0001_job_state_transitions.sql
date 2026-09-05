-- Row checks validate snapshots; this trigger validates changes between snapshots.
CREATE FUNCTION enforce_job_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.queue, NEW.payload, NEW.max_attempts, NEW.idempotency_key, NEW.created_at)
        IS DISTINCT FROM
       (OLD.id, OLD.queue, OLD.payload, OLD.max_attempts, OLD.idempotency_key, OLD.created_at) THEN
        RAISE EXCEPTION 'Job identity and submission are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('completed', 'dead') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Terminal jobs are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'queued' AND NEW.status = 'processing') OR
        (OLD.status = 'processing' AND NEW.status IN ('queued', 'completed', 'dead'))
    ) THEN
        RAISE EXCEPTION 'Illegal job state transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.attempts <> OLD.attempts + (CASE WHEN OLD.status = 'queued' AND NEW.status = 'processing' THEN 1 ELSE 0 END) THEN
        RAISE EXCEPTION 'Attempts increase exactly once per claim' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'processing' AND NEW.status IN ('queued', 'dead') AND OLD.lease_expires_at > clock_timestamp() THEN
        RAISE EXCEPTION 'Cannot recover an active lease' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'processing' AND NEW.status = 'completed' AND
        (OLD.worker_id IS DISTINCT FROM NEW.worker_id OR OLD.lease_expires_at <= clock_timestamp()) THEN
        RAISE EXCEPTION 'Cannot complete an expired or reassigned lease' USING ERRCODE = 'JQ001';
    END IF;
    IF OLD.status = 'processing' AND NEW.status = 'processing' AND
        (NEW.worker_id, NEW.lease_expires_at) IS DISTINCT FROM (OLD.worker_id, OLD.lease_expires_at) THEN
        RAISE EXCEPTION 'Active leases cannot be reassigned or extended' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER jobs_enforce_transition BEFORE UPDATE ON jobs
FOR EACH ROW EXECUTE FUNCTION enforce_job_transition();
