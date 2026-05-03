import * as React from "react"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        hex:
          "clip-parallelogram border-transparent bg-[#E0FF00] text-black px-4",
        "hex-success":
          "clip-parallelogram border-transparent bg-[#00FF88]/20 text-[#00FF88] px-4",
        "hex-error":
          "clip-parallelogram border-transparent bg-[#FF3366]/20 text-[#FF3366] px-4",
        "hex-warning":
          "clip-parallelogram border-transparent bg-[#FFAA00]/20 text-[#FFAA00] px-4",
        "hex-outline":
          "clip-chamfer-sm border-[#E0FF00]/40 bg-transparent text-[#E0FF00]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  ...props
}) {
  return (<div className={cn(badgeVariants({ variant }), className)} {...props} />);
}

export { Badge, badgeVariants }
