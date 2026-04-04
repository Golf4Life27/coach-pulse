"use client";

import { useState, useEffect } from "react";

const quotes = [
  { text: "Your income is directly proportional to your outreach volume.", author: "AKB MINDSET" },
  { text: "Speed to lead wins.", author: "AKB MINDSET" },
  { text: "Stop overthinking. Start texting. Close deals.", author: "AKB MINDSET" },
  { text: "Every text sent is a lottery ticket that costs nothing.", author: "AKB MINDSET" },
  { text: "The pipeline doesn\u2019t reset \u2014 it compounds.", author: "AKB MINDSET" },
  { text: "Losing deals by being too low is acceptable. Being on the wrong side of math is not.", author: "AKB MINDSET" },
  { text: "The system buys the tickets for you while you eat breakfast with your kids.", author: "AKB MINDSET" },
  { text: "Every deal you close funds the next phase of automation.", author: "AKB MINDSET" },
  { text: "Volume is the game and you are playing it right.", author: "AKB MINDSET" },
  { text: "A 5-hour workweek is not bought. It is built.", author: "AKB MINDSET" },
];

export default function QuotesBar() {
  const [index, setIndex] = useState(0);
  const [fade, setFade] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setIndex((prev) => (prev + 1) % quotes.length);
        setFade(true);
      }, 500);
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-[#1a5c3a] border-b border-[#2a7c5a] px-4 py-2.5 text-center overflow-hidden">
      <p
        className={`text-sm font-medium text-white transition-opacity duration-500 ${
          fade ? "opacity-100" : "opacity-0"
        }`}
      >
        &ldquo;{quotes[index].text}&rdquo;{" "}
        <span className="text-emerald-300 font-bold">&mdash; {quotes[index].author}</span>
      </p>
    </div>
  );
}
