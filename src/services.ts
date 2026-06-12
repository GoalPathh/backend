import { supabaseAuth } from "./supabase.js";
import { AppError } from "./errors.js";
import { CoachRepository, DashboardRepository, GoalRepository, UserRepository } from "./repositories.js";
export class AuthService {
  async register(input:{email:string;password:string;name:string}) { const {data,error}=await supabaseAuth.auth.signUp({email:input.email,password:input.password,options:{data:{name:input.name}}}); if(error) throw new AppError(error.message,400); return data; }
  async login(input:{email:string;password:string}) { const {data,error}=await supabaseAuth.auth.signInWithPassword(input); if(error) throw new AppError(error.message,401); return data; }
}
export class GoalService { constructor(private repo=new GoalRepository()){} list(u:string){return this.repo.list(u)} get(u:string,id:string){return this.repo.find(u,id)} create(u:string,i:unknown){return this.repo.create(u,i)} update(u:string,id:string,i:unknown){return this.repo.update(u,id,i)} remove(u:string,id:string){return this.repo.remove(u,id)} }
export class UserService { constructor(private repo=new UserRepository()){} profile(u:string){return this.repo.profile(u)} updateProfile(u:string,i:unknown){return this.repo.updateProfile(u,i)} preferences(u:string){return this.repo.preferences(u)} updatePreferences(u:string,i:unknown){return this.repo.updatePreferences(u,i)} }
export class DashboardService { constructor(private repo=new DashboardRepository()){} today(u:string){return this.repo.today(u)} progress(u:string){return this.repo.progress(u)} }
export class CoachService { constructor(private repo=new CoachRepository()){} sessions(u:string){return this.repo.sessions(u)} createSession(u:string,title?:string){return this.repo.createSession(u,title)} messages(u:string,id:string){return this.repo.messages(u,id)} addMessage(u:string,id:string,role:string,content:string){return this.repo.addMessage(u,id,role,content)} }
