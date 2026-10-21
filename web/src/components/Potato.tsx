import React from "react";

export type Mood = "calm" | "panic" | "burned" | "king";

interface Props {
  mood: Mood;
  size?: number;
  className?: string;
}

// Hand-drawn-style potato mascot (SVG, thick outlines). Not emoji, not stock.
export function Potato({ mood, size = 160, className }: Props) {
  const skin = mood === "burned" ? "#3a2a20" : "#F3C969";
  const shade = mood === "burned" ? "#241812" : "#d9a94a";
  const eye = mood === "burned" ? "#e9e2cf" : "#241812";
  return (
    <svg
      viewBox="0 0 200 220"
      width={size}
      height={size * 1.1}
      className={className}
      role="img"
      aria-label={`potato mascot, ${mood}`}
    >
      <defs>
        <radialGradient id="spud" cx="40%" cy="35%" r="75%">
          <stop offset="0%" stopColor={skin} />
          <stop offset="100%" stopColor={shade} />
        </radialGradient>
      </defs>

      {/* body */}
      <path
        d="M100 18 C150 18 178 60 176 110 C174 165 150 205 100 205 C50 205 26 165 24 110 C22 60 50 18 100 18 Z"
        fill="url(#spud)"
        stroke="#241812"
        strokeWidth="7"
        strokeLinejoin="round"
      />
      {/* potato eyes/dimples */}
      <ellipse cx="62" cy="150" rx="7" ry="5" fill="#b98a37" opacity=".6" />
      <ellipse cx="140" cy="60" rx="6" ry="4" fill="#b98a37" opacity=".6" />
      <ellipse cx="120" cy="165" rx="5" ry="4" fill="#b98a37" opacity=".5" />

      {/* eyes */}
      {mood === "calm" && (
        <>
          <circle cx="76" cy="96" r="9" fill={eye} />
          <circle cx="124" cy="96" r="9" fill={eye} />
        </>
      )}
      {mood === "panic" && (
        <>
          <circle cx="76" cy="94" r="16" fill="#fff" stroke="#241812" strokeWidth="4" />
          <circle cx="124" cy="94" r="16" fill="#fff" stroke="#241812" strokeWidth="4" />
          <circle cx="78" cy="98" r="6" fill="#241812" />
          <circle cx="126" cy="98" r="6" fill="#241812" />
        </>
      )}
      {mood === "burned" && (
        <>
          <path d="M62 88 l28 16 M90 88 l-28 16" stroke="#e9e2cf" strokeWidth="6" strokeLinecap="round" />
          <path d="M110 88 l28 16 M138 88 l-28 16" stroke="#e9e2cf" strokeWidth="6" strokeLinecap="round" />
        </>
      )}
      {mood === "king" && (
        <>
          <path d="M62 96 q14 -14 28 0" stroke="#241812" strokeWidth="6" fill="none" strokeLinecap="round" />
          <circle cx="124" cy="96" r="9" fill={eye} />
        </>
      )}

      {/* mouth */}
      {mood === "calm" && (
        <path d="M80 132 q20 16 40 0" stroke="#241812" strokeWidth="6" fill="none" strokeLinecap="round" />
      )}
      {mood === "panic" && (
        <ellipse cx="100" cy="140" rx="14" ry="18" fill="#241812" />
      )}
      {mood === "burned" && (
        <path d="M80 148 q20 -16 40 0" stroke="#e9e2cf" strokeWidth="6" fill="none" strokeLinecap="round" />
      )}
      {mood === "king" && (
        <path d="M78 134 q22 12 44 0" stroke="#241812" strokeWidth="6" fill="none" strokeLinecap="round" />
      )}

      {/* sweat on panic */}
      {mood === "panic" && (
        <path d="M158 78 q8 12 0 20 q-8 -8 0 -20Z" fill="#7ec8ff" stroke="#241812" strokeWidth="3" />
      )}

      {/* crown for king */}
      {mood === "king" && (
        <path
          d="M60 40 l16 14 l24 -22 l24 22 l16 -14 l-6 30 l-68 0 Z"
          fill="#FFD23F"
          stroke="#241812"
          strokeWidth="5"
          strokeLinejoin="round"
        />
      )}

      {/* smoke when burned */}
      {mood === "burned" && (
        <path
          d="M92 12 q-10 -14 2 -24 q14 8 4 24 M116 6 q-8 -12 2 -20"
          stroke="#9aa0a6"
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
          opacity=".8"
        />
      )}
    </svg>
  );
}
