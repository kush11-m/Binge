import { useEffect, useState } from 'react';
import { Socket } from 'socket.io-client';
import { StreamingProvider } from '../providers/StreamingProvider';
import { LANProvider } from '../providers/LANProvider';
import { WebRTCProvider } from '../providers/WebRTCProvider';
import { normalizeServerBase } from '../services/connection';
import type { StreamMode } from '../types';

export function useStreaming(
  socket: Socket | null, 
  roomId: string | null, 
  mode?: StreamMode, 
  videoUrl?: string | null,
  isHost?: boolean,
  hostId?: string | null,
  hlsUrl?: string | null,
  serverBase?: string
) {
  const [provider, setProvider] = useState<StreamingProvider | null>(null);
  
  useEffect(() => {
    if (!socket || !roomId || !mode || !videoUrl) return;

    const resolvedServerBase = normalizeServerBase(serverBase || (() => {
      const host = window.location.hostname;
      const fallbackPort = process.env.NEXT_PUBLIC_SERVER_PORT || "3002";
      return process.env.NEXT_PUBLIC_SERVER_URL || `http://${host}:${fallbackPort}`;
    })());

    let newProvider: StreamingProvider;
    if (mode === 'LAN') {
      newProvider = new LANProvider(resolvedServerBase, videoUrl, hlsUrl);
    } else {
      newProvider = new WebRTCProvider(socket, roomId, isHost || false, hostId || null, resolvedServerBase, videoUrl);
    }
    
    setProvider(newProvider);

    return () => {
      newProvider.destroy();
    };
  }, [socket, roomId, mode, videoUrl, isHost, hostId, hlsUrl, serverBase]);

  return provider;
}
