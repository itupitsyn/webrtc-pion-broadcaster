import { Call } from "@/components/Call";
import type { Metadata } from "next";

/**
 * A room's own address, the thing you paste into a chat. It carries the room
 * name and nothing else — no participant identity, no token — so the link is
 * exactly as secret as the room name is.
 */
interface RoomPageProps {
  params: Promise<{ room: string }>;
}

export async function generateMetadata({ params }: RoomPageProps): Promise<Metadata> {
  const { room } = await params;

  return { title: `${decodeURIComponent(room)} · Group call` };
}

export default async function RoomPage({ params }: RoomPageProps) {
  const { room } = await params;

  // Prefilled rather than joined outright: joining asks for the camera, and a
  // page that grabs it on load — before you have even seen where you landed —
  // is how you get a permission prompt denied out of reflex.
  return <Call initialRoom={decodeURIComponent(room)} />;
}
