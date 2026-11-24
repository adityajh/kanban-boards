import Plan from '../../../components/Plan';

export default function Page({ params }) {
  return <Plan slug={params.slug} />;
}
