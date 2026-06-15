import { supabaseAuth } from "./supabase.js";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { CoachRepository, DashboardRepository, GoalRepository, MilestoneRepository, UserRepository } from "./repositories.js";
export class AuthService {
  async register(input:{email:string;password:string;name:string}) { const {data,error}=await supabaseAuth.auth.signUp({email:input.email,password:input.password,options:{data:{name:input.name}}}); if(error) throw new AppError(error.message,400); return data; }
  async login(input:{email:string;password:string}) { const {data,error}=await supabaseAuth.auth.signInWithPassword(input); if(error) throw new AppError(error.message,401); return data; }
  async refresh(refreshToken:string) { const {data,error}=await supabaseAuth.auth.refreshSession({refresh_token:refreshToken}); if(error) throw new AppError(error.message,401); return data; }
  async googleOAuth(next:string) {
    const redirectTo = new URL("/auth/callback", config.frontendUrl);
    redirectTo.searchParams.set("next", next);
    const { data, error } = await supabaseAuth.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirectTo.toString(), skipBrowserRedirect: true },
    });
    if (error) throw new AppError(error.message, 400);
    return { url: data.url };
  }
}
export class GoalService { constructor(private repo=new GoalRepository()){} list(u:string){return this.repo.list(u)} get(u:string,id:string){return this.repo.find(u,id)} create(u:string,i:unknown){return this.repo.create(u,i)} update(u:string,id:string,i:unknown){return this.repo.update(u,id,i)} remove(u:string,id:string){return this.repo.remove(u,id)} }
export class UserService { constructor(private repo=new UserRepository()){} profile(u:string){return this.repo.profile(u)} updateProfile(u:string,i:unknown){return this.repo.updateProfile(u,i)} preferences(u:string){return this.repo.preferences(u)} updatePreferences(u:string,i:unknown){return this.repo.updatePreferences(u,i)} }
export class DashboardService { constructor(private repo=new DashboardRepository()){} today(u:string){return this.repo.today(u)} getUserContextSnapshot(u:string){return this.repo.getUserContextSnapshot(u)} setCompletion(u:string,id:string,c:boolean,d?:string){return this.repo.setCompletion(u,id,c,d)} progressDash(u:string){return this.repo.getProgressDash(u)} goalPerformance(u:string){return this.repo.getGoalPerformance(u)} recomputeGoal(u:string,id:string){return this.repo.recomputeGoalProgress(u,id)} }
export class CoachService { constructor(private repo=new CoachRepository()){} sessions(u:string){return this.repo.sessions(u)} createSession(u:string,title?:string){return this.repo.createSession(u,title)} renameSession(u:string,id:string,title:string){return this.repo.renameSession(u,id,title)} deleteSession(u:string,id:string){return this.repo.deleteSession(u,id)} messages(u:string,id:string){return this.repo.messages(u,id)} addMessage(u:string,id:string,role:string,content:string){return this.repo.addMessage(u,id,role,content)} }
export class MilestoneService { constructor(private repo=new MilestoneRepository()){} listOf(u:string,goalId:string){return this.repo.list(u,goalId)} bulkReplace(u:string,goalId:string,items:Array<{title:string;target_date?:string;sort_order?:number}>){return this.repo.bulkInsert(u,goalId,items)} setDone(u:string,id:string,done:boolean){return this.repo.setDone(u,id,done)} remove(u:string,id:string){return this.repo.remove(u,id)} }
