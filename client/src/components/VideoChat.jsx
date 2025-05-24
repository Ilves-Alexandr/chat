import React, { useEffect, useRef, useState, useCallback } from "react";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./VideoChat.css";
import { ReactComponent as PlusIcon } from "../assets/icons/plus.svg";
import { ReactComponent as MinusIcon } from "../assets/icons/minus.svg";
import { ReactComponent as SpeakerWaveIcon } from "../assets/icons/speaker-wave.svg";
import { ReactComponent as SpeakerXMarkIcon } from "../assets/icons/speaker-x-mark.svg";
import { ReactComponent as PhoneIcon } from "../assets/icons/phone.svg";
import { ReactComponent as PhoneXMarkIcon } from "../assets/icons/phone-x-mark.svg";

const iceConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export default function VideoChat({ ws, clientId, recipientId }) {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callStatus, setCallStatus] = useState("idle"); // idle, calling, in_call
  const [incomingOffer, setIncomingOffer] = useState(null);
  const [remoteVolume, setRemoteVolume] = useState(1); // 0…1
  const [micMuted, setMicMuted] = useState(false);

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

      // если это входящий оффер и мы свободны — сохраняем и ждём действия пользователя
      if (msg.signalType === "video_offer" && callStatus === "idle") {
        setIncomingOffer(msg.offer);
        return;
      }

      // иначе обрабатываем ответ или айс
      const pc = pcRef.current;
      if (msg.signalType === "video_answer" && pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
        setCallStatus("in_call");
      } else if (msg.signalType === "ice_candidate" && pc) {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } else {
          incomingIceBuffer.current.push(msg.candidate);
        }
      }
    };

    ws.addEventListener("message", onMessage);
    return () => ws.removeEventListener("message", onMessage);
  }, [ws, callStatus]);

  // Общая логика для установления соединения (используется и при принятии, и при инициации)
  const setupConnection = useCallback(
    async (isInitiator, remoteOffer = null) => {
      const pc = new RTCPeerConnection(iceConfig);
      pcRef.current = pc;
      incomingIceBuffer.current = [];

      // Получаем локалку
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      setLocalStream(stream);
      // Не выводим локальный звук в плеер
      const videoOnly = new MediaStream(stream.getVideoTracks());
      localVideoRef.current.srcObject = videoOnly;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));

      // ICE candidate
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

      // ontrack для удалёнки
      pc.ontrack = (e) => {
        const [s] = e.streams;
        setRemoteStream(s);
        remoteVideoRef.current.srcObject = s;
      };

      if (isInitiator) {
        // Инициируем звонок
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(
          JSON.stringify({
            type: "video_signal",
            signalType: "video_offer",
            offer: offer,
            clientId,
            recipientId,
          })
        );
        setCallStatus("calling");
      } else if (remoteOffer) {
        // Принимаем звонок
        await pc.setRemoteDescription(new RTCSessionDescription(remoteOffer));
        // добавляем накопленные кандидаты
        for (const c of incomingIceBuffer.current) {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        }
        incomingIceBuffer.current = [];

        // Отвечаем
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(
          JSON.stringify({
            type: "video_signal",
            signalType: "video_answer",
            answer: answer,
            clientId,
            recipientId,
          })
        );
        setCallStatus("in_call");
      }
    },
    [ws, clientId, recipientId]
  );

  // Кнопка «Принять» (для баннера входящего звонка)
  const acceptCall = () => {
    if (incomingOffer) {
      setupConnection(false, incomingOffer);
      setIncomingOffer(null);
    }
  };

  // Кнопка «Отклонить»
  const rejectCall = () => {
    setIncomingOffer(null);
  };

  // Инициировать звонок
  const startCall = useCallback(() => {
    setupConnection(true);
  }, [setupConnection]);

  // Завершить звонок
  const endCall = () => {
    pcRef.current?.close();
    localStream?.getTracks().forEach((t) => t.stop());
    remoteStream?.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
    setRemoteStream(null);
    setCallStatus("idle");
  };

  const changeRemoteVolume = (delta) => {
    if (!remoteVideoRef.current) return;
    let v = remoteVideoRef.current.volume + delta;
    v = Math.min(1, Math.max(0, v));
    remoteVideoRef.current.volume = v;
    setRemoteVolume(v);
  };

  // Включаем/выключаем микрофон
  const toggleMicMute = () => {
    if (!localStream) return;
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = micMuted; // если сейчас muted=true, включаем, иначе — выключаем
    });
    setMicMuted(!micMuted);
  };

  return (
    <div className="video-chat-container">
      <div className="video-container">
        <div>
          <h3>Ваше видео</h3>
          <video
            className="local_video"
            ref={localVideoRef}
            autoPlay
            playsInline
          />
        </div>
        <div>
          <h3>Видео собеседника</h3>
          <video
            className="remote_video"
            ref={remoteVideoRef}
            autoPlay
            playsInline
          />
        </div>
      </div>
      {callStatus === "idle" ? (
        <button className="video_btn btn" onClick={startCall}>
          <PhoneIcon className="phone-icon" />
        </button>
      ) : (
        <button className="video_btn btn" onClick={endCall}>
          <PhoneXMarkIcon className="phone-x-mark_icon" />
        </button>
      )}
      <div className="video-controls">
        {/* Громкость удалёнки ↓ */}
        <button
          className="btn vol-down"
          onClick={() => changeRemoteVolume(-0.1)}
        >
          <MinusIcon className="minus-icon" />
        </button>
        <span className="vol-display">{Math.round(remoteVolume * 100)}%</span>
        <button className="btn vol-up" onClick={() => changeRemoteVolume(+0.1)}>
          <PlusIcon className="plus-icon" />
        </button>

        {/* Mute микрофона */}
        <button
          className={`btn mic-toggle ${micMuted ? "muted" : ""}`}
          onClick={toggleMicMute}
        >
          {micMuted ? (
            <SpeakerWaveIcon className="speaker-wave_icon" />
          ) : (
            <SpeakerXMarkIcon className="speaker-x-mark_icon" />
          )}
        </button>
      </div>
      <ToastContainer position="bottom-right" autoClose={3000} />
    </div>
  );
}
