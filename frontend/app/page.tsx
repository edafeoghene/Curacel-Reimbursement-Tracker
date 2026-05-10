import { redirect } from "next/navigation";

// The signed-in landing page just hands the user to /tickets — that's the
// real dashboard surface. Unsigned-in visitors never reach this code path
// because the proxy (proxy.ts) redirects them to /login first.
export default function Home() {
  redirect("/tickets");
}
