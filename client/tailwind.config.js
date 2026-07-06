/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        neon: "#39ff88",
        panel: "#080d0a",
        canvas: "#050806",
        surface: "#0b120e",
        wash: "#121b16",
        ink: "#f4fff8",
        muted: "#93a39a",
        line: "#1f3027",
        ready: "#39ff88"
      },
      boxShadow: {
        glow: "0 0 24px rgba(57, 255, 136, 0.24)",
        soft: "0 22px 70px rgba(0, 0, 0, 0.42)"
      },
      keyframes: {
        rise: {
          "0%": { opacity: 0, transform: "translateY(10px)" },
          "100%": { opacity: 1, transform: "translateY(0)" }
        },
        pulseGlow: {
          "0%, 100%": { boxShadow: "0 0 8px rgba(0, 255, 136, 0.4)" },
          "50%": { boxShadow: "0 0 16px rgba(0, 255, 136, 0.7)" }
        }
      },
      animation: {
        rise: "rise 0.6s ease-out",
        pulseGlow: "pulseGlow 2.8s ease-in-out infinite"
      },
      borderRadius: {
        xl: "1.25rem"
      }
    }
  },
  plugins: []
};
