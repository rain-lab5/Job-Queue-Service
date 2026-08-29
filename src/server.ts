import express, {type Request, type Response} from "express";
import { handleHealth } from "./handlers/handleHealth.js";

const app  = express();

app.get("/api/v1/health",handleHealth);

app.listen(8080, ()=>{
    console.log("[+] Listening on http://localhost:8080");
});