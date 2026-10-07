import { redirect } from 'next/navigation';

export default function LoginPage() {
  // This app is a Telegram WebApp — redirect to the game
  redirect('/game.html');
}
