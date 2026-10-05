import InitialSync from './InitialSync';
import './App.css';

export default function App() {
  return <main>
    <h1>Cropster sync</h1>
    <p>Send existing products and orders to Cropster page by page: all of them, or only those created on or after a date you choose. New changes are sent automatically once Enable Integration is on. Keep this page open until each sync completes.</p>
    <InitialSync />
  </main>;
}
