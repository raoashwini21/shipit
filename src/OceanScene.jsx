/* Decorative animated seascape behind the app: sun, clouds, gulls,
 * layered waves and a couple of ships sailing across. Purely visual. */

const W = 2880; // twice the viewBox width we show, so the waves can loop
const H = 260;

// A repeating wave: crest/trough every period/2. `T` mirrors the previous
// control point, so one Q plus a run of Ts gives a clean sine-like curve.
function wavePath(y, amp, period) {
  let d = `M0 ${y} Q ${period / 4} ${y - amp * 2} ${period / 2} ${y}`;
  for (let x = period; x <= W; x += period / 2) d += ` T ${x} ${y}`;
  return `${d} V ${H} H 0 Z`;
}

function Wave({ className, y, amp, period, fill, foam }) {
  return (
    <svg className={`wave ${className}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={wavePath(y, amp, period)} fill={fill} />
      {foam && (
        <path
          d={wavePath(y, amp, period).replace(/ V .*$/, '')}
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.55"
          strokeWidth="3"
        />
      )}
    </svg>
  );
}

function SailShip() {
  return (
    <svg viewBox="0 0 120 100" width="120" height="100">
      {/* flag */}
      <path className="flag" d="M60 6 L60 0 L76 4 L60 8 Z" fill="#ef5b4c" />
      {/* mast */}
      <rect x="58.5" y="4" width="3" height="70" rx="1.5" fill="#0b3553" />
      {/* sails */}
      <path className="sail" d="M63 10 C 88 26 96 48 102 70 L63 70 Z" fill="#ffffff" />
      <path d="M63 10 C 76 30 80 50 82 70 L63 70 Z" fill="#e6f2fa" />
      <path className="sail" d="M56 16 C 40 34 30 52 24 70 L56 70 Z" fill="#f7fbff" />
      <path d="M56 40 L42 70 L56 70 Z" fill="#dbeaf5" />
      {/* hull */}
      <path d="M8 72 L114 72 L100 92 Q 60 97 22 92 Z" fill="#0b3553" />
      <path d="M12 76 L110 76" stroke="#ffffff" strokeWidth="2.5" />
      <circle cx="40" cy="84" r="2.6" fill="#7cc4ec" />
      <circle cx="60" cy="85" r="2.6" fill="#7cc4ec" />
      <circle cx="80" cy="84" r="2.6" fill="#7cc4ec" />
    </svg>
  );
}

function Cloud() {
  return (
    <svg viewBox="0 0 200 80" width="200" height="80">
      <path
        d="M30 70 C 5 70 5 42 30 42 C 32 20 62 12 78 28 C 90 6 132 8 138 34 C 162 26 186 40 180 62 C 186 70 176 72 168 70 Z"
        fill="#ffffff"
      />
    </svg>
  );
}

function Gull() {
  return (
    <svg viewBox="0 0 30 12" width="30" height="12">
      <path className="wing" d="M1 8 Q 8 0 15 8 Q 22 0 29 8" fill="none" stroke="#2b5a7a" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function OceanScene() {
  return (
    <div className="scene" aria-hidden="true">
      <div className="sun" />

      <div className="cloud c1"><Cloud /></div>
      <div className="cloud c2"><Cloud /></div>
      <div className="cloud c3"><Cloud /></div>

      <div className="gulls g1"><Gull /><Gull /></div>
      <div className="gulls g2"><Gull /></div>

      <div className="sea">
        <Wave className="w1" y={70} amp={8} period={720} fill="#9fd4f0" />
        <div className="ship far"><div className="rock"><SailShip /></div></div>
        <Wave className="w2" y={110} amp={11} period={480} fill="#5cb3e4" />
        <div className="ship near"><div className="rock"><SailShip /></div></div>
        <Wave className="w3" y={150} amp={10} period={720} fill="#2a8fce" foam />
        <div className="glints">
          {Array.from({ length: 12 }, (_, i) => (
            <span key={i} style={{ left: `${(i * 37) % 100}%`, bottom: `${24 + ((i * 29) % 80)}px`, animationDelay: `${(i * 0.73) % 4}s` }} />
          ))}
        </div>
        <Wave className="w4" y={200} amp={8} period={360} fill="#146fb0" foam />
      </div>
    </div>
  );
}
