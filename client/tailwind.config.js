/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./pages/**/*.{js,jsx}", "./components/**/*.{js,jsx}", "./hooks/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        neon: "#00ff88",
        panel: "#0b0b0b"
      },
      boxShadow: {
        glow: "0 0 16px rgba(0, 255, 136, 0.5)"
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
