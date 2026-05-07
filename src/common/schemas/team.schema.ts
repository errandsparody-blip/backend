import { z } from "zod";

export const inviteSubUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});
export type InviteSubUserInput = z.infer<typeof inviteSubUserSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(16).max(255),
  password: z
    .string()
    .min(12, "Password must be at least 12 characters.")
    .max(128, "Password must be 128 characters or fewer."),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
