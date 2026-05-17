'use client';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export const BackgroundGradientAnimation = ({
    gradientBackgroundStart = 'rgba(0, 0, 0, 0)',
    gradientBackgroundEnd = 'rgba(0, 0, 0, 0)',
    firstColor = '18, 113, 255',
    secondColor = '221, 74, 255',
    thirdColor = '100, 220, 255',
    fourthColor = '200, 50, 50',
    fifthColor = '180, 180, 50',
    pointerColor = '140, 100, 255',
    size = '80%',
    blendingValue = 'hard-light',
    children,
    className,
    interactive = true,
    containerClassName,
    brightness = 0.2,
}: {
    gradientBackgroundStart?: string;
    gradientBackgroundEnd?: string;
    firstColor?: string;
    secondColor?: string;
    thirdColor?: string;
    fourthColor?: string;
    fifthColor?: string;
    pointerColor?: string;
    size?: string;
    blendingValue?: string;
    children?: React.ReactNode;
    className?: string;
    interactive?: boolean;
    containerClassName?: string;
    brightness?: number;
}) => {
    const interactiveRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const [curX, setCurX] = useState(0);
    const [curY, setCurY] = useState(0);
    const [tgX, setTgX] = useState(0);
    const [tgY, setTgY] = useState(0);

    useEffect(() => {
        if (!containerRef.current) return;

        containerRef.current.style.setProperty(
            '--gradient-background-start',
            gradientBackgroundStart,
        );
        containerRef.current.style.setProperty(
            '--gradient-background-end',
            gradientBackgroundEnd,
        );
        containerRef.current.style.setProperty('--first-color', firstColor);
        containerRef.current.style.setProperty('--second-color', secondColor);
        containerRef.current.style.setProperty('--third-color', thirdColor);
        containerRef.current.style.setProperty('--fourth-color', fourthColor);
        containerRef.current.style.setProperty('--fifth-color', fifthColor);
        containerRef.current.style.setProperty('--pointer-color', pointerColor);
        containerRef.current.style.setProperty('--size', size);
        containerRef.current.style.setProperty('--blending-value', blendingValue);
        containerRef.current.style.setProperty('--brightness', String(brightness));
    }, [
        gradientBackgroundStart,
        gradientBackgroundEnd,
        firstColor,
        secondColor,
        thirdColor,
        fourthColor,
        fifthColor,
        pointerColor,
        size,
        blendingValue,
        brightness,
    ]);

    useEffect(() => {
        let animationFrameId: number;
        function move() {
            if (!interactiveRef.current) {
                return;
            }
            setCurX((prevCurX) => prevCurX + (tgX - prevCurX) / 20);
            setCurY((prevCurY) => prevCurY + (tgY - prevCurY) / 20);
            interactiveRef.current.style.transform = `translate(${Math.round(
                curX,
            )}px, ${Math.round(curY)}px)`;
            animationFrameId = requestAnimationFrame(move);
        }

        move();
        return () => cancelAnimationFrame(animationFrameId);
    }, [tgX, tgY, curX, curY]);
    const [hasInteracted, setHasInteracted] = useState(false);

    const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
        if (!hasInteracted) {
            setHasInteracted(true);
        }
        if (interactiveRef.current) {
            const rect = interactiveRef.current.getBoundingClientRect();
            setTgX(event.clientX - rect.left);
            setTgY(event.clientY - rect.top);
        }
    };

    const [isSafari, setIsSafari] = useState(false);
    useEffect(() => {
        setIsSafari(/^((?!chrome|android).)*safari/i.test(navigator.userAgent));
    }, []);

    return (
        <div
            ref={containerRef}
            className={cn(
                'h-screen w-screen relative overflow-hidden top-0 left-0 bg-[linear-gradient(40deg,var(--gradient-background-start),var(--gradient-background-end))]',
                containerClassName,
            )}
        >
            <svg className="hidden">
                <defs>
                    <filter id="blurMe">
                        <feGaussianBlur
                            in="SourceGraphic"
                            stdDeviation="10"
                            result="blur"
                        />
                        <feColorMatrix
                            in="blur"
                            mode="matrix"
                            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8"
                            result="goo"
                        />
                        <feBlend in="SourceGraphic" in2="goo" />
                    </filter>
                </defs>
            </svg>
            <div className={cn('relative z-50 w-full h-full', className)}>{children}</div>
            <div
                style={{
                    filter: isSafari
                        ? 'blur(40px) brightness(var(--brightness, 1.0))'
                        : 'url(#blurMe) blur(40px) brightness(var(--brightness, 1.0))',
                }}
                className="absolute inset-0 gradients-container h-full w-full z-0"
            >
                {/* <div
                    className={cn(
                        'absolute [background:radial-gradient(circle_at_center,_rgba(var(--first-color),_0.8)_0,_rgba(var(--first-color),_0)_50%)_no-repeat]',
                        '[mix-blend-mode:var(--blending-value)] w-[var(--size)] h-[var(--size)] top-[calc(50%-var(--size)/2)] left-[calc(50%-var(--size)/2)]',
                        '[transform-origin:center_center]',
                        'animate-first',
                        'opacity-100',
                    )}
                ></div> */}
                <div
                    className={cn(
                        'absolute [background:radial-gradient(circle_at_center,_rgba(var(--second-color),_0.8)_0,_rgba(var(--second-color),_0)_50%)_no-repeat]',
                        '[mix-blend-mode:var(--blending-value)] w-[var(--size)] h-[var(--size)] top-[calc(50%-var(--size)/2)] left-[calc(50%-var(--size)/2)]',
                        '[transform-origin:calc(50%-400px)]',
                        'animate-second',
                        'opacity-100',
                    )}
                ></div>
                <div
                    className={cn(
                        'absolute [background:radial-gradient(circle_at_center,_rgba(var(--third-color),_0.8)_0,_rgba(var(--third-color),_0)_50%)_no-repeat]',
                        '[mix-blend-mode:var(--blending-value)] w-[var(--size)] h-[var(--size)] top-[calc(50%-var(--size)/2)] left-[calc(50%-var(--size)/2)]',
                        '[transform-origin:calc(50%+400px)]',
                        'animate-third',
                        'opacity-100',
                    )}
                ></div>
                <div
                    className={cn(
                        'absolute [background:radial-gradient(circle_at_center,_rgba(var(--fourth-color),_0.8)_0,_rgba(var(--fourth-color),_0)_50%)_no-repeat]',
                        '[mix-blend-mode:var(--blending-value)] w-[var(--size)] h-[var(--size)] top-[calc(50%-var(--size)/2)] left-[calc(50%-var(--size)/2)]',
                        '[transform-origin:calc(50%-200px)]',
                        'animate-fourth',
                        'opacity-70',
                    )}
                ></div>
                <div
                    className={cn(
                        'absolute [background:radial-gradient(circle_at_center,_rgba(var(--fifth-color),_0.8)_0,_rgba(var(--fifth-color),_0)_50%)_no-repeat]',
                        '[mix-blend-mode:var(--blending-value)] w-[var(--size)] h-[var(--size)] top-[calc(50%-var(--size)/2)] left-[calc(50%-var(--size)/2)]',
                        '[transform-origin:calc(50%-800px)_calc(50%+800px)]',
                        'animate-fifth',
                        'opacity-100',
                    )}
                ></div>

                {interactive && (
                    <div
                        ref={interactiveRef}
                        onMouseMove={handleMouseMove}
                        className={cn(
                            'absolute [background:radial-gradient(circle_at_center,_rgba(var(--pointer-color),_0.8)_0,_rgba(var(--pointer-color),_0)_50%)_no-repeat]',
                            '[mix-blend-mode:var(--blending-value)] w-full h-full -top-1/2 -left-1/2',
                            hasInteracted ? 'opacity-70' : 'opacity-0',
                        )}
                    ></div>
                )}
            </div>
        </div>
    );
};
