import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

const switchVariants = {
  default: {
    root: "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
    thumb: "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
  },
  hex: {
    root: "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center clip-chamfer-sm border-2 border-transparent shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[#E0FF00] data-[state=checked]:shadow-[0_0_10px_rgba(224,255,0,0.3)] data-[state=unchecked]:bg-input",
    thumb: "pointer-events-none block h-4 w-4 clip-hex bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
  },
};

const Switch = React.forwardRef(({ className, variant = "default", ...props }, ref) => {
  const v = switchVariants[variant] || switchVariants.default;
  return (
    <SwitchPrimitives.Root
      className={cn(v.root, className)}
      {...props}
      ref={ref}>
      <SwitchPrimitives.Thumb className={cn(v.thumb)} />
    </SwitchPrimitives.Root>
  );
})
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
