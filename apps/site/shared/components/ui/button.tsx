import * as React from 'react';

type ButtonVariant = 'primary' | 'secondary';

interface ButtonProps extends React.ComponentPropsWithoutRef<'a'> {
  variant?: ButtonVariant;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-fg text-bg border-fg hover:bg-transparent hover:text-fg',
  secondary: 'bg-transparent text-fg border-border hover:border-fg',
};

const Button = React.forwardRef<HTMLAnchorElement, ButtonProps>(
  ({ variant = 'primary', className = '', children, ...props }, ref) => (
    <a
      ref={ref}
      className={`group inline-flex items-center gap-2 rounded-full border px-7 py-3.5 font-semibold no-underline transition-[background-color,color,border-color] duration-150 hover:no-underline ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    >
      {children}
    </a>
  ),
);
Button.displayName = 'Button';

export { Button };
