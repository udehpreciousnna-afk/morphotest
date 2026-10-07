import { redirect } from 'next/navigation';

export default function SignupPage() {
  // This app is a Telegram WebApp — redirect to the game
  redirect('/game.html');
}
