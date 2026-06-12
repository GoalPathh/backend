import cors from "cors"; import express from "express"; import helmet from "helmet"; import morgan from "morgan";
import { config } from "./config.js"; import { errorHandler,notFound,resolveUser } from "./middleware.js"; import { apiRouter } from "./routes.js";
export const app=express(); app.use(helmet()); app.use(cors({origin:config.frontendUrl,credentials:true})); app.use(express.json({limit:"1mb"})); app.use(morgan("dev")); app.use(resolveUser); app.use("/api/v1",apiRouter); app.use(notFound); app.use(errorHandler);
