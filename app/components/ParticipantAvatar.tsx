import Image from "next/image";
import type { ParticipantId } from "@/lib/app-data";
import { participantAvatarSrc } from "@/lib/participant-avatars";

export function ParticipantAvatar({
  participantId,
  className = "",
  priority = false,
}: {
  participantId: ParticipantId;
  className?: string;
  priority?: boolean;
}) {
  return (
    <span className={`wb-avatar ${className}`.trim()} aria-hidden="true">
      <Image
        src={participantAvatarSrc(participantId)}
        alt=""
        width={256}
        height={256}
        sizes="(max-width: 699px) 88px, 112px"
        priority={priority}
        // Public copies are already reduced to 384px. The vinext local image
        // proxy cannot access its static-asset binding, so serve them directly.
        unoptimized
        draggable={false}
      />
    </span>
  );
}
