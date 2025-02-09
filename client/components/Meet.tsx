import { useBroadcaster } from "@/hooks/useBroadcaster";
import { useWatcher } from "@/hooks/useWatcher";
import axios from "axios";
import { Button, TextInput } from "flowbite-react";
import { FC, useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";

type MeetProps = {
  onBackClick: () => void;
};

export const Meet: FC<MeetProps> = ({ onBackClick }) => {
  const [name, setName] = useState("");
  const [interlocutor, setInterlocutor] = useState("");

  const senderRef = useRef<HTMLVideoElement>(null);
  const receiverRef = useRef<HTMLVideoElement>(null);

  const { startBroadcasting, stopBroadcasting, isBroadcasting } = useBroadcaster(senderRef, name);
  const { startWatching, stopWatching, isWatching } = useWatcher(receiverRef, interlocutor);
  const [tickTack, setTickTack] = useState(false);

  useEffect(() => {
    if (!isBroadcasting || isWatching) return;

    let tmtId: ReturnType<typeof setTimeout> | undefined;
    const handler = async () => {
      try {
        const response = await axios.get<string[]>(`${process.env.NEXT_PUBLIC_API_URL}/interlocutor`);
        if (response.data.length <= 1) {
          tmtId = setTimeout(() => {
            setTickTack((prev) => !prev);
          }, 1000);
        } else {
          const interlocutorName = response.data.filter((item) => item !== name)[0];
          if (!interlocutorName) {
            tmtId = setTimeout(() => {
              setTickTack((prev) => !prev);
            }, 1000);
          } else {
            setInterlocutor(interlocutorName);
            setTimeout(startWatching);
          }
        }
      } catch {
        toast.error("Error getting interlocutor");
      }
    };

    handler();

    return () => {
      clearTimeout(tmtId);
    };
  }, [isBroadcasting, isWatching, name, startWatching, tickTack]);

  return (
    <>
      <div className="flex gap-4 self-center">
        <Button
          onClick={() => {
            stopWatching();
            stopBroadcasting();
            onBackClick();
          }}
          gradientDuoTone="purpleToBlue"
          outline
        >
          Back
        </Button>
        <TextInput
          disabled={isBroadcasting}
          className="grow"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {isBroadcasting ? (
          <Button
            gradientDuoTone="purpleToBlue"
            onClick={() => {
              stopBroadcasting();
              stopWatching();
            }}
          >
            Disconnect
          </Button>
        ) : (
          <Button gradientDuoTone="purpleToBlue" onClick={startBroadcasting}>
            Call
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-6">
        <video ref={senderRef} width="640" height="480" autoPlay muted className="w-[640px] max-w-full" />
        <video ref={receiverRef} width="640" height="480" autoPlay className="w-[640px] max-w-full" />
      </div>
    </>
  );
};
