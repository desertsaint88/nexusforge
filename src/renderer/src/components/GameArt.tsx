import { useEffect, useMemo, useState } from 'react'
import type { Game } from '@shared/types'
import { cn, initials, nameHues } from '../lib/format'

/** Walks a list of image URLs, moving on whenever one fails to load. */
function useImageChain(urls: string[]): { src?: string; onError(): void } {
  const key = urls.join('|')
  const [index, setIndex] = useState(0)
  useEffect(() => setIndex(0), [key])
  return { src: urls[index], onError: () => setIndex((i) => i + 1) }
}

function Generated({ game, variant }: { game: Pick<Game, 'name' | 'art'>; variant: 'capsule' | 'hero' }) {
  const [a, b] = nameHues(game.name)
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden"
      style={{
        background: `radial-gradient(120% 90% at 20% 10%, hsl(${a} 70% 45% / 0.85), transparent 60%), radial-gradient(120% 90% at 90% 100%, hsl(${b} 80% 40% / 0.8), transparent 60%), #0d0f15`
      }}
    >
      <div className="absolute inset-0 opacity-[0.15]" style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgba(255,255,255,.4) 0 1px, transparent 1px 14px)' }} />
      {/* The card overlay already shows the name, so the art only carries the icon or initials. */}
      {variant === 'capsule' && (
        <div className="relative -mt-10 flex flex-col items-center">
          {game.art.icon ? (
            <div className="rounded-3xl border border-white/15 bg-black/30 p-3 shadow-[0_10px_40px_rgba(0,0,0,0.5)] backdrop-blur-md">
              <img src={game.art.icon} alt="" className="size-16 object-contain" draggable={false} />
            </div>
          ) : (
            <div className="text-6xl font-black tracking-tighter text-white/90 drop-shadow-[0_4px_24px_rgba(0,0,0,0.5)]">{initials(game.name)}</div>
          )}
        </div>
      )}
    </div>
  )
}

/** Portrait 2:3 artwork with fallbacks: custom → capsule → header composed on a blurred backdrop → generated. */
export function CapsuleArt({ game, className }: { game: Pick<Game, 'name' | 'art' | 'customArt'>; className?: string }) {
  const capsules = useMemo(() => [game.customArt?.capsule, ...game.art.capsule].filter(Boolean) as string[], [game.customArt?.capsule, game.art.capsule])
  const capsule = useImageChain(capsules)
  const header = useImageChain(game.art.header)
  return (
    <div className={cn('overflow-hidden bg-ink-850', !/\b(absolute|fixed)\b/.test(className ?? '') && 'relative', className)}>
      {capsule.src ? (
        <img src={capsule.src} onError={capsule.onError} alt="" className="absolute inset-0 size-full object-cover" draggable={false} loading="lazy" />
      ) : header.src ? (
        <>
          <img src={header.src} alt="" className="absolute inset-0 size-full scale-125 object-cover opacity-60 blur-2xl" draggable={false} />
          <img src={header.src} onError={header.onError} alt="" className="absolute inset-x-0 top-1/2 w-full -translate-y-1/2 object-cover shadow-2xl" draggable={false} loading="lazy" />
        </>
      ) : (
        <Generated game={game} variant="capsule" />
      )}
    </div>
  )
}

export function HeroArt({ game, className }: { game: Pick<Game, 'name' | 'art' | 'customArt'>; className?: string }) {
  const urls = useMemo(
    () => [game.customArt?.hero, ...game.art.hero, ...game.art.header, game.customArt?.capsule, ...game.art.capsule].filter(Boolean) as string[],
    [game.customArt?.hero, game.customArt?.capsule, game.art.hero, game.art.header, game.art.capsule]
  )
  const hero = useImageChain(urls)
  const isWide = hero.src && (game.customArt?.hero === hero.src || game.art.hero.includes(hero.src))
  return (
    <div className={cn('absolute inset-0 overflow-hidden', className)}>
      {hero.src ? (
        <img
          src={hero.src}
          onError={hero.onError}
          alt=""
          draggable={false}
          className={cn('absolute inset-0 size-full object-cover', !isWide && 'scale-110 blur-xl brightness-75')}
        />
      ) : (
        <Generated game={game} variant="hero" />
      )}
    </div>
  )
}

export function GameLogo({ game, className }: { game: Pick<Game, 'name' | 'art'>; className?: string }) {
  const logo = useImageChain(game.art.logo)
  if (!logo.src) return <h1 className={cn('text-5xl font-black tracking-tight text-white drop-shadow-[0_4px_30px_rgba(0,0,0,0.6)]', className)}>{game.name}</h1>
  return <img src={logo.src} onError={logo.onError} alt={game.name} draggable={false} className={cn('max-h-28 max-w-[460px] object-contain object-left drop-shadow-[0_8px_30px_rgba(0,0,0,0.7)]', className)} />
}

export function GameIcon({ game, className }: { game: Pick<Game, 'name' | 'art' | 'customArt'>; className?: string }) {
  const sources = useMemo(() => [game.art.icon, ...game.art.header, ...game.art.capsule].filter(Boolean) as string[], [game.art.icon, game.art.header, game.art.capsule])
  const chain = useImageChain(sources)
  const [a, b] = nameHues(game.name)
  return (
    <div className={cn('relative shrink-0 overflow-hidden rounded-lg bg-ink-800', className)}>
      {chain.src ? (
        <img src={chain.src} onError={chain.onError} alt="" draggable={false} className={cn('absolute inset-0 size-full', chain.src === game.art.icon ? 'object-contain p-0.5' : 'object-cover')} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white" style={{ background: `linear-gradient(135deg, hsl(${a} 65% 45%), hsl(${b} 70% 35%))` }}>
          {initials(game.name)}
        </div>
      )}
    </div>
  )
}
