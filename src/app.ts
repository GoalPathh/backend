import cors from "cors"; import express from "express"; import helmet from "helmet"; import morgan from "morgan"; import cookieParser from "cookie-parser";
import swaggerUi from "swagger-ui-express";
import { config } from "./config.js"; import { errorHandler,notFound,resolveUser } from "./middleware.js"; import { apiRouter } from "./routes.js";
import { openApiDocument } from "./openapi.js";
export const app=express(); app.use(helmet()); app.use(cors({origin:config.frontendUrl,credentials:true})); app.use(express.json({limit:"1mb"})); app.use(cookieParser()); app.use(morgan("dev"));
app.get("/api/openapi.json",(_req,res)=>res.json(openApiDocument));
app.use("/api/docs",(_req,res,next)=>{
  res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'");
  next();
},swaggerUi.serve,swaggerUi.setup(openApiDocument,{customSiteTitle:"GoalPath API Docs"}));
app.use(resolveUser); app.use("/api/v1",apiRouter); app.use(notFound); app.use(errorHandler);
