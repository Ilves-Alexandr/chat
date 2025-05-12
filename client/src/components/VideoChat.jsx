import React, { useEffect, useRef, useState, useCallback } from "react";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./VideoChat.css";

const iceConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export default function VideoChat({ ws, clientId, recipientId }) {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callStatus, setCallStatus] = useState("idle"); // idle, calling, in_call

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pcRef = useRef(null);
  const incomingIceBuffer = useRef([]);

  // ============ сигналинг ============
  useEffect(() => {
    if (!ws) return;

    const onMessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type !== "video_signal") return;
      const pc = pcRef.current;

      // OFFER
      if (msg.signalType === "video_offer") {
        const pc = new RTCPeerConnection(iceConfig);
        pcRef.current = pc;
        incomingIceBuffer.current = [];

        // получаем локалку
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        setLocalStream(stream);
        localVideoRef.current.srcObject = stream;
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));

        // слушаем свои ICE
        pc.onicecandidate = (e) => {
          if (e.candidate) {
            ws.send(
              JSON.stringify({
                type: "video_signal",
                signalType: "ice_candidate",
                candidate: e.candidate,
                clientId,
                recipientId,
              })
            );
          }
        };

        // принимаем чужие ICE (до и после setRemoteDescription)
        document.addEventListener("videoSignal", async (ev) => {
          const d = ev.detail;
          if (d.signalType === "ice_candidate") {
            if (pc.remoteDescription && pc.remoteDescription.type) {
              await pc.addIceCandidate(new RTCIceCandidate(d.candidate));
            } else {
              incomingIceBuffer.current.push(d.candidate);
            }
          }
        });

        // ontrack для отображения удалёнки
        pc.ontrack = (e) => {
          const [s] = e.streams;
          setRemoteStream(s);
          remoteVideoRef.current.srcObject = s;
        };

        // ставим удалённый оффер
        await pc.setRemoteDescription(
          new RTCSessionDescription(msg.offer)
        );
        // вываливаем накопленные ICE
        for (const c of incomingIceBuffer.current) {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        }
        incomingIceBuffer.current = [];

        // отвечаем
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(
          JSON.stringify({
            type: "video_signal",
            signalType: "video_answer",
            answer: pc.localDescription,
            clientId,
            recipientId,
          })
        );
        setCallStatus("in_call");
        return;
      }

      // ANSWER
      if (msg.signalType === "video_answer" && pc) {
        await pc.setRemoteDescription(
          new RTCSessionDescription(msg.answer)
        );
        setCallStatus("in_call");
        return;
      }

      // ICE
      if (msg.signalType === "ice_candidate" && pc) {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } else {
          incomingIceBuffer.current.push(msg.candidate);
        }
        return;
      }
    };

    ws.addEventListener("message", onMessage);
    return () => ws.removeEventListener("message", onMessage);
  }, [ws, clientId, recipientId]);

  // ============ инициатор ============
  const startCall = useCallback(async () => {
    const pc = new RTCPeerConnection(iceConfig);
    pcRef.current = pc;
    incomingIceBuffer.current = [];

    // локалка
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    setLocalStream(stream);
    localVideoRef.current.srcObject = stream;
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    // ontrack для удалёнки
    pc.ontrack = (e) => {
      const [s] = e.streams;
      setRemoteStream(s);
      remoteVideoRef.current.srcObject = s;
    };

    // свои ICE
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        ws.send(
          JSON.stringify({
            type: "video_signal",
            signalType: "ice_candidate",
            candidate: e.candidate,
            clientId,
            recipientId,
          })
        );
      }
    };

    // создаём оффер и отправляем
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(
      JSON.stringify({
        type: "video_signal",
        signalType: "video_offer",
        offer: pc.localDescription,
        clientId,
        recipientId,
      })
    );
    setCallStatus("calling");
  }, [ws, clientId, recipientId]);

  const endCall = () => {
    pcRef.current?.close();
    localStream?.getTracks().forEach((t) => t.stop());
    remoteStream?.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
    setRemoteStream(null);
    setCallStatus("idle");
  };

  return (
    <div className="video-chat-container">
      <h2>Video Chat</h2>
      {callStatus === "idle" ? (
        <button onClick={startCall}>Начать звонок</button>
      ) : (
        <button onClick={endCall}>Завершить звонок</button>
      )}
      <div className="video-container">
        <div>
          <h3>Ваше видео</h3>
          <video ref={localVideoRef} autoPlay playsInline />
        </div>
        <div>
          <h3>Видео собеседника</h3>
          <video ref={remoteVideoRef} autoPlay playsInline />
        </div>
      </div>
      <ToastContainer position="bottom-right" autoClose={3000} />
    </div>
  );
}
