import axios from "axios";
import { RefObject } from "react";
import { toast } from "react-toastify";

export const processPCError = (e: unknown, pc: RTCPeerConnection, ref: RefObject<HTMLVideoElement>) => {
  destroyStream(pc, ref);
  if (axios.isAxiosError(e)) {
    toast.error(e.response?.data);
  } else {
    toast.error("Unexpected error");
  }
  log(e);
};

export const destroyStream = (pc: RTCPeerConnection, ref: RefObject<HTMLVideoElement>) => {
  if (ref.current?.srcObject) {
    ref.current.srcObject = null;
  }
  pc.close();
};

export const log = (text: unknown) => {
  const elem = document.getElementById("logs");
  if (elem) {
    const newLog = document.createElement("div");
    newLog.innerText = `${new Date().toLocaleDateString("en-US", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })} ${text}`;
    elem.appendChild(newLog);
    newLog.scrollIntoView({ behavior: "smooth" });
  }
};

export const clearLog = () => {
  const elem = document.getElementById("logs");
  if (elem) {
    elem.innerHTML = "";
  }
};
