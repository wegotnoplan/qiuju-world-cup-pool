import type { ParticipantId } from "./app-data";

const AVATAR_SRC: Record<ParticipantId, string> = {
  gao: "/avatars/gao.png",
  ye: "/avatars/ye.png",
  dong: "/avatars/dong.png",
  qiu: "/avatars/qiu.png",
  kang: "/avatars/kang.png",
  bo: "/avatars/bo.png",
  zhao: "/avatars/zhao.png",
};

export function participantAvatarSrc(participantId: ParticipantId): string {
  return AVATAR_SRC[participantId];
}
