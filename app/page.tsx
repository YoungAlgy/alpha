import { redirect } from "next/navigation";

// The landing has been replaced by the onboarding funnel.
// Direct visits to /alpha drop straight into the welcome screen.
export default function Root() {
  redirect("/welcome");
}
