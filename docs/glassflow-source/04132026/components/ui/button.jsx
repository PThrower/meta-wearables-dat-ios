import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        hex:
          "clip-chamfer-sm bg-[#E0FF00] text-black font-semibold shadow-[0_0_20px_rgba(224,255,0,0.3)] hover:shadow-[0_0_30px_rgba(224,255,0,0.5)] hover:scale-[1.02] active:scale-[0.98]",
        "hex-outline":
          "clip-chamfer-sm border border-[#E0FF00] bg-transparent text-[#E0FF00] hover:bg-[#E0FF00]/10 hover:scale-[1.02] active:scale-[0.98]",
        "hex-ghost":
          "bg-transparent text-[#E0FF00] hover:bg-transparent relative after:absolute after:bottom-0 after:left-1 after:right-1 after:h-0.5 after:bg-[#E0FF00] after:scale-x-0 hover:after:scale-x-100 after:transition-transform after:origin-left",
        "hex-icon":
          "clip-hex bg-[#E0FF00]/15 border border-[#E0FF00]/30 text-[#E0FF00] hover:bg-[#E0FF00]/25 hover:scale-[1.05] active:scale-[0.95]",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
        "hex-icon": "h-12 w-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props} />
  );
})
Button.displayName = "Button"

export { Button, buttonVariants }
