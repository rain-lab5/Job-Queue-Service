import {drizzle} from 'drizzle-orm/postgres-js';
import postgres from "postgres";
import 'dotenv/config';

const dbUrl = process.env.DATABASE_URL;
if(!dbUrl)
{
throw new Error("[!] database link is not set!")
}
const client = postgres(dbUrl, {
    connect_timeout : 5,
});
export const db = drizzle(client);

