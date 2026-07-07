import { useEffect, useState } from "react";
import { io } from "socket.io-client";

export function useSocket(serverUrl) {
  const [socket, setSocket] = useState(null);
  const [connectionState, setConnectionState] = useState({
    status: "idle",
    detail: "Not connected"
  });

  useEffect(() => {
    if (!serverUrl) return;
    const proxiedPath = serverUrl.startsWith("/") ? `${serverUrl.replace(/\/$/, "")}/socket.io` : undefined;
    const socketInstance = io(serverUrl.startsWith("/") ? window.location.origin : serverUrl, {
      path: proxiedPath,
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 8000
    });

    setConnectionState({ status: "connecting", detail: "Connecting" });
    setSocket(socketInstance);

    function handleConnect() {
      setConnectionState({
        status: "connected",
        detail: socketInstance.io.engine?.transport?.name || "connected"
      });
    }

    function handleDisconnect(reason) {
      setConnectionState({
        status: socketInstance.active ? "reconnecting" : "offline",
        detail: reason || "Disconnected"
      });
    }

    function handleReconnectAttempt(attempt) {
      setConnectionState({
        status: "reconnecting",
        detail: `Reconnect attempt ${attempt}`
      });
    }

    function handleConnectError(error) {
      setConnectionState({
        status: "offline",
        detail: error?.message || "Connection failed"
      });
    }

    socketInstance.on("connect", handleConnect);
    socketInstance.on("disconnect", handleDisconnect);
    socketInstance.on("connect_error", handleConnectError);
    socketInstance.io.on("reconnect_attempt", handleReconnectAttempt);
    socketInstance.io.on("reconnect", handleConnect);

    return () => {
      socketInstance.off("connect", handleConnect);
      socketInstance.off("disconnect", handleDisconnect);
      socketInstance.off("connect_error", handleConnectError);
      socketInstance.io.off("reconnect_attempt", handleReconnectAttempt);
      socketInstance.io.off("reconnect", handleConnect);
      socketInstance.disconnect();
    };
  }, [serverUrl]);

  return { socket, connectionState };
}
