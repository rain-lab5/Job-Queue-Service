import express, {type Request, type Response} from "express";
const app  = express();

app.get("/api/v1/health",(req : Request, res : Response)=>{
    res.status(200).send("[!] Backend working properly");
});

app.listen(8080, ()=>{
    console.log("[+] Listening on http://localhost:8080");
});