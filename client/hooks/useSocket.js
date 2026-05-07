import { useEffect, useState } from "react";
import { io } from "socket.io-client";

export function useSocket(serverUrl) {
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    if (!serverUrl) return;
    const socketInstance = io(serverUrl, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 5,
      timeout: 8000
    });

    setSocket(socketInstance);

    return () => {
      socketInstance.disconnect();
    };
  }, [serverUrl]);

  return socket;
}
