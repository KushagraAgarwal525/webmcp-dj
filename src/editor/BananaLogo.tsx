/** Flat banana mark for BananaLabs chrome. */
export function BananaLogo({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="banana-logo"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden
      focusable="false"
    >
      {/* peel body */}
      <path
        d="M7.2 8.4c1.2-2.6 4.4-4.2 7.8-3.6 5.6 1 11.2 6.2 12.6 12.4 1 4.4-.6 8.2-4.2 9.6-2.2.8-4.2.2-5.2-1.6-.4-.8.2-1.4 1-.1.8 1.2 2.2 1.4 3.6.8 2.4-.9 3.4-3.6 2.6-6.8C23.4 13.2 18.8 8.8 14.4 8c-2.4-.4-4.4.6-5.2 2.4-.4.8-1.4.8-1.8.2-.4-.6-.2-1.6-.2-2.2z"
        fill="#ffd60a"
      />
      {/* inner curve shadow */}
      <path
        d="M10.6 12.2c2.2-1.6 5.6-1.8 8.8.4 3.4 2.4 5.4 6.2 4.8 9.2-.2 1.2-1 2-1.8 2.2 1.8-2.4 1.2-6.2-1.6-9-2.8-2.8-6.6-3.4-9.2-2.2-.6.2-1.2-.2-1-.6z"
        fill="#e6b800"
        opacity="0.55"
      />
      {/* stem tip */}
      <path
        d="M8.2 6.2c-.2-1.4.4-2.6 1.6-3.2.6-.3 1.2 0 1.2.6 0 .8-.2 1.6-.6 2.4-.4.8-1.4 1.2-2.2.8-.2-.2-.2-.4 0-.6z"
        fill="#5a8f2a"
      />
      {/* stem nub */}
      <ellipse cx="9.2" cy="4.2" rx="1.1" ry="0.7" fill="#3d6b18" transform="rotate(-35 9.2 4.2)" />
    </svg>
  );
}
