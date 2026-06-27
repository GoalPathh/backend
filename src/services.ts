import { supabaseAdmin, supabaseAuth } from "./supabase.js";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { CoachRepository, DashboardRepository, GoalRepository, MilestoneRepository, NotificationRepository, PersonaRepository, SubscriptionRepository, UserRepository } from "./repositories.js";
import { deriveAdvice } from "./services/personaClassifier.js";
import { SubscriptionService } from "./services/subscriptionService.js";

export class AuthService {
  async register(input:{email:string;password:string;name:string}) { const {data,error}=await supabaseAuth.auth.signUp({email:input.email,password:input.password,options:{data:{name:input.name}}}); if(error) throw new AppError(error.message,400); return data; }
  async login(input:{email:string;password:string}) { const {data,error}=await supabaseAuth.auth.signInWithPassword(input); if(error) throw new AppError(error.message,401); return data; }
  async refresh(refreshToken:string) { const {data,error}=await supabaseAuth.auth.refreshSession({refresh_token:refreshToken}); if(error) throw new AppError(error.message,401); return data; }
  async forgotPassword(email:string) {
    const redirectTo = new URL("/reset-password", config.frontendUrl).toString();
    const { error } = await supabaseAuth.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw new AppError(error.message, 400);
    return { message: "If an account exists for this email, a password reset link has been sent." };
  }
  async updatePassword(userId:string,password:string) {
    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password });
    if (error) throw new AppError(error.message, 400);
    return { user: data.user };
  }
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
export class GoalService { constructor(private repo=new GoalRepository()){} list(u:string){return this.repo.list(u)} dashboard(u:string){return this.repo.dashboard(u)} get(u:string,id:string){return this.repo.find(u,id)} create(u:string,i:unknown){return this.repo.create(u,i)} update(u:string,id:string,i:unknown){return this.repo.update(u,id,i)} remove(u:string,id:string){return this.repo.remove(u,id)} }
export class UserService { constructor(private repo=new UserRepository()){} overview(u:string){return this.repo.overview(u)} profile(u:string){return this.repo.profile(u)} updateProfile(u:string,i:unknown){return this.repo.updateProfile(u,i)} preferences(u:string){return this.repo.preferences(u)} updatePreferences(u:string,i:unknown){return this.repo.updatePreferences(u,i)} avatarUploadSignature(u:string){return this.repo.createAvatarUploadSignature(u)} }
export class DashboardService { constructor(private repo=new DashboardRepository()){} today(u:string){return this.repo.today(u)} getUserContextSnapshot(u:string){return this.repo.getUserContextSnapshot(u)} setCompletion(u:string,id:string,c:boolean,d?:string){return this.repo.setCompletion(u,id,c,d)} progressDash(u:string){return this.repo.getProgressDash(u)} progressOverview(u:string,range:string){return this.repo.getProgressOverview(u,range)} goalPerformance(u:string){return this.repo.getGoalPerformance(u)} recomputeGoal(u:string,id:string){return this.repo.recomputeGoalProgress(u,id)} }
export class NotificationService { constructor(private repo=new NotificationRepository()){} list(u:string){return this.repo.list(u)} markAllRead(u:string){return this.repo.markAllRead(u)} }
export class CoachService { constructor(private repo=new CoachRepository()){} sessions(u:string){return this.repo.sessions(u)} createSession(u:string,title?:string){return this.repo.createSession(u,title)} renameSession(u:string,id:string,title:string){return this.repo.renameSession(u,id,title)} deleteSession(u:string,id:string){return this.repo.deleteSession(u,id)} messages(u:string,id:string){return this.repo.messages(u,id)} addMessage(u:string,id:string,role:string,content:string){return this.repo.addMessage(u,id,role,content)} }
export class PersonaService {
  constructor(private repo = new PersonaRepository()) {}

  async compute(u: string, windowDays: number, force = false) {
    if (!force) {
      const cached = await this.repo.getCached(u, windowDays, 60 * 60 * 1000);
      if (cached) {
        const traits = (cached as any).traits;
        const evidence = (cached as any).evidence;
        return {
          archetype: (cached as any).archetype,
          headline: "",
          traits,
          evidence,
          advice: deriveAdvice((cached as any).archetype, traits, evidence),
          generatedAt: (cached as any).computed_at,
          windowDays: (cached as any).window_days,
        };
      }
    }

    return this.repo.compute(u, windowDays);
  }

  getCoachContext(u: string, windowDays = 14) {
    return this.repo.getCoachContext(u, windowDays);
  }
}
export class MilestoneService { constructor(private repo=new MilestoneRepository()){} listOf(u:string,goalId:string){return this.repo.list(u,goalId)} bulkReplace(u:string,goalId:string,items:Array<{title:string;target_date?:string;sort_order?:number}>){return this.repo.bulkInsert(u,goalId,items)} setDone(u:string,id:string,done:boolean){return this.repo.setDone(u,id,done)} remove(u:string,id:string){return this.repo.remove(u,id)} }

/**
 * SubscriptionService wrapper — proxies the raw service so future TTL/caching
 * and event-emission hooks can be added here without touching call sites.
 */
export class SubscriptionFacade {
  constructor(
    private service: SubscriptionService = new SubscriptionService(),
  ) {}

  getMySubscription(userId: string) { return this.service.getMySubscription(userId); }
  isPremiumActive(userId: string) { return this.service.isPremiumActive(userId); }
  createCheckout(userId: string, profile: { name?: string | null; email?: string | null }) {
    return this.service.createCheckout(userId, profile);
  }
  handleWebhook(notification: unknown) {
    return this.service.handleWebhook(notification as Parameters<SubscriptionService["handleWebhook"]>[0]);
  }
  cancel(userId: string) { return this.service.cancel(userId); }

  assertCanCreateGoal(userId: string) { return this.service.assertCanCreateGoal(userId); }
  assertCanCreateHabit(userId: string, goalId: string) { return this.service.assertCanCreateHabit(userId, goalId); }
  assertCanSendCoachMessage(userId: string) { return this.service.assertCanSendCoachMessage(userId); }
  assertPremium(userId: string) { return this.service.assertPremium(userId); }
}

/**
 * SubscriptionRepository re-exported for backward compat with future migrations
 * (e.g. plan-history lookup). Implementation lives in ./repositories.
 */
export { SubscriptionRepository };
